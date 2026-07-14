import asyncio
import base64
import binascii
import hashlib
import logging
import email
import ssl

import httpx

from aiosmtpd.controller import Controller
from aiosmtpd.smtp import (
    MISSING,
    SMTP,
    Session,
    Envelope,
    AuthResult,
    LoginPassword,
)

from config import settings

_logger = logging.getLogger(__name__)
_logger.setLevel(logging.INFO)


def _safe_decode_payload(payload, charset):
    if payload is None:
        return ""
    try:
        return payload.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def _safe_header(value) -> str:
    if value is None:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(value)))
    except (TypeError, ValueError, UnicodeError):
        return str(value)


def _looks_like_jwt(value: str) -> bool:
    parts = value.split(".")
    return len(parts) == 3 and parts[0].startswith("eyJ")


def build_smtp_idempotency_key(authenticated_address: str, envelope: Envelope) -> str:
    """Return the same bounded key when an SMTP client retries the same DATA."""
    digest = hashlib.sha256()
    parts = [
        authenticated_address.strip().lower().encode("utf-8"),
        str(envelope.mail_from or "").strip().lower().encode("utf-8"),
        "\n".join(sorted(str(item).strip().lower() for item in envelope.rcpt_tos)).encode("utf-8"),
    ]
    content = envelope.content
    parts.append(content if isinstance(content, bytes) else str(content or "").encode("utf-8"))
    for part in parts:
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return f"smtp-sha256-{digest.hexdigest()}"


class CustomSMTPHandler:

    def __init__(self, client=None):
        self._client = client or httpx.AsyncClient(
            timeout=settings.imap_http_timeout,
            headers={
                "x-custom-auth": settings.basic_password,
                "Content-Type": "application/json",
            },
        )

    def authenticator(self, server, session, envelope, mechanism, auth_data):
        # LOGIN and PLAIN are implemented as async handler hooks below. Keep
        # the fallback closed so a future mechanism cannot bypass verification.
        return AuthResult(success=False, handled=False)

    async def _verify_credentials(self, login: bytes, password: bytes) -> AuthResult:
        try:
            username = login.decode("utf-8").strip().lower()
            credential = password.decode("utf-8").strip()
        except UnicodeDecodeError:
            return AuthResult(success=False)
        if not username or not credential:
            return AuthResult(success=False)

        try:
            if _looks_like_jwt(credential):
                response = await self._client.get(
                    f"{settings.proxy_url.rstrip('/')}/api/settings",
                    headers={
                        "Authorization": f"Bearer {credential}",
                        "x-custom-auth": settings.basic_password,
                    },
                )
                if response.status_code != 200:
                    return AuthResult(success=False)
                address = str(response.json().get("address") or "").strip().lower()
                if not address or address != username:
                    return AuthResult(success=False)
                resolved = credential
            else:
                response = await self._client.post(
                    f"{settings.proxy_url.rstrip('/')}/api/address_login",
                    json={"email": username, "password": credential},
                    headers={
                        "x-custom-auth": settings.basic_password,
                        "Content-Type": "application/json",
                    },
                )
                if response.status_code != 200:
                    return AuthResult(success=False)
                resolved = str(response.json().get("jwt") or "").strip()
                if not resolved:
                    return AuthResult(success=False)
        except (httpx.HTTPError, ValueError, TypeError):
            _logger.warning("SMTP credential verification failed")
            return AuthResult(success=False)

        return AuthResult(
            success=True,
            auth_data=LoginPassword(username.encode("utf-8"), resolved.encode("utf-8")),
        )

    async def auth_PLAIN(self, server: SMTP, args) -> AuthResult:
        if len(args) == 1:
            auth_value = await server.challenge_auth("")
            if auth_value is MISSING:
                return AuthResult(success=False)
        else:
            try:
                auth_value = base64.b64decode(args[1].encode("ascii"), validate=True)
            except (ValueError, UnicodeError, binascii.Error):
                await server.push("501 5.5.2 Invalid authentication payload")
                return AuthResult(success=False, handled=True)
        try:
            _, login, password = auth_value.split(b"\x00")
        except ValueError:
            await server.push("501 5.5.2 Invalid authentication payload")
            return AuthResult(success=False, handled=True)
        return await self._verify_credentials(login, password)

    async def auth_LOGIN(self, server: SMTP, args) -> AuthResult:
        if len(args) == 1:
            login = await server.challenge_auth(server.AuthLoginUsernameChallenge)
            if login is MISSING:
                return AuthResult(success=False)
        else:
            try:
                login = base64.b64decode(args[1].encode("ascii"), validate=True)
            except (ValueError, UnicodeError, binascii.Error):
                await server.push("501 5.5.2 Invalid username encoding")
                return AuthResult(success=False, handled=True)
        password = await server.challenge_auth(server.AuthLoginPasswordChallenge)
        if password is MISSING:
            return AuthResult(success=False)
        return await self._verify_credentials(login, password)

    async def handle_DATA(self, server: SMTP, session: Session, envelope: Envelope) -> str:
        _logger.info(
            f"handle_DATA from {envelope.mail_from} to {envelope.rcpt_tos}"
        )
        if not isinstance(session.auth_data, LoginPassword):
            return '530 Authentication required'
        if len(envelope.rcpt_tos) != 1:
            return '500 Only one recipient allowed'
        # Only one recipient allowed
        to_mail = envelope.rcpt_tos[0]
        # Parse email
        msg = email.message_from_string(envelope.content)
        content_list = []
        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                charset = part.get_content_charset()
                cte = str(part.get('content-transfer-encoding', '')).lower()
                if content_type not in ["text/plain", "text/html"]:
                    _logger.warning(f"Skipping {content_type}")
                    continue
                if cte == "8bit":
                    value = part.get_payload(decode=False)
                else:
                    payload = part.get_payload(decode=True)
                    value = _safe_decode_payload(payload, charset)
                if not value:
                    continue
                content_list.append({
                    "type": content_type,
                    "value": value
                })
        elif msg.get_content_type() in ["text/plain", "text/html"] and msg.get_payload(decode=True):
            cte = str(msg.get('content-transfer-encoding', '')).lower()
            charset = msg.get_content_charset()
            if cte == "8bit":
                value = msg.get_payload(decode=False)
            else:
                payload = msg.get_payload(decode=True)
                value = _safe_decode_payload(payload, charset)
            _logger.debug("Parsed content charset=%s", charset)
            content_list.append({
                "type": msg.get_content_type(),
                "value": value
            })

        if not content_list:
            return '500 Invalid content'
        body = max(
            content_list,
            key=lambda x: (x["type"] == "text/html", len(x["value"]))
        )
        from_name, _ = email.utils.parseaddr(_safe_header(msg.get('From')))
        to_mail_map = {}
        to_header = _safe_header(msg.get('To'))
        for to in to_header.split(",") if to_header else []:
            tmp_to_name, tmp_to_mail = email.utils.parseaddr(to)
            if tmp_to_mail:
                to_mail_map[tmp_to_mail.lower()] = tmp_to_name
        _logger.info(f"Parsed mail from {from_name} to {to_mail_map}")
        # Send mail
        send_body = {
            "token": session.auth_data.password.decode(),
            "idempotency_key": build_smtp_idempotency_key(
                session.auth_data.login.decode(), envelope
            ),
            "from_name": from_name,
            "to_name": to_mail_map.get(to_mail.lower()),
            "to_mail": to_mail,
            "subject": _safe_header(msg.get('Subject')),
            "is_html": body["type"] == "text/html",
            "content": body["value"],
        }
        _logger.info(f"Send mail {dict(send_body, token='***')}")
        try:
            res = await self._client.post(
                f"{settings.proxy_url}/external/api/send_mail",
                json=send_body, headers={
                    "Content-Type": "application/json"
                }
            )
            if res.status_code != 200:
                _logger.error(
                    "Failed to send mail "
                    f"code=[{res.status_code}] text=[{res.text}]"
                )
                if 400 <= res.status_code < 500:
                    return '550 5.7.1 Message rejected by backend'
                return '451 4.3.0 Temporary backend failure'
        except httpx.HTTPError:
            _logger.exception("SMTP backend request failed")
            return '451 4.3.0 Temporary backend failure'

        return '250 OK'


def start_smtp_server():
    handler = CustomSMTPHandler()

    tls_context = None
    has_cert = bool(settings.smtp_tls_cert)
    has_key = bool(settings.smtp_tls_key)
    if has_cert != has_key:
        raise ValueError(
            "Both smtp_tls_cert and smtp_tls_key must be set together"
        )
    if has_cert and has_key:
        _logger.info("TLS enabled for SMTP (STARTTLS)")
        tls_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        tls_context.options |= ssl.OP_NO_SSLv2 | ssl.OP_NO_SSLv3
        tls_context.load_cert_chain(settings.smtp_tls_cert, settings.smtp_tls_key)

    server = Controller(
        handler,
        hostname="",
        port=settings.port,
        auth_require_tls=bool(tls_context),
        decode_data=True,
        auth_exclude_mechanism=["DONT"],
        tls_context=tls_context,
    )

    _logger.info(
        "Starting SMTP server on port %s tls=%s",
        settings.port, bool(tls_context),
    )
    server.start()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_forever()
    except KeyboardInterrupt:
        _logger.info("Got KeyboardInterrupt, stopping")
        server.stop()


if __name__ == "__main__":
    _logger.info(
        "Starting SMTP server proxy_url=%s port=%s tls=%s",
        settings.proxy_url, settings.port,
        bool(settings.smtp_tls_cert and settings.smtp_tls_key),
    )
    start_smtp_server()
