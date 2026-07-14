import unittest
from types import SimpleNamespace

from aiosmtpd.smtp import LoginPassword

from smtp_server import CustomSMTPHandler, build_smtp_idempotency_key


class _Response:
    status_code = 200
    text = "ok"


class _RecordingClient:
    def __init__(self):
        self.requests = []

    async def post(self, url, *, json, headers):
        self.requests.append({"url": url, "json": json, "headers": headers})
        return _Response()


def _envelope(content: str, recipient: str = "to@example.net"):
    return SimpleNamespace(
        mail_from="sender@example.com",
        rcpt_tos=[recipient],
        content=content,
    )


MESSAGE = """From: Sender <sender@example.com>
To: Receiver <to@example.net>
Subject: Retry-safe message
Message-ID: <stable-message@example.com>
Content-Type: text/plain; charset=utf-8

hello
"""


class SmtpIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    def test_key_is_stable_for_retries_and_changes_with_the_smtp_message(self):
        first = build_smtp_idempotency_key("Sender@Example.com", _envelope(MESSAGE))
        retry = build_smtp_idempotency_key("sender@example.com", _envelope(MESSAGE))
        changed = build_smtp_idempotency_key(
            "sender@example.com",
            _envelope(MESSAGE.replace("hello", "different")),
        )

        self.assertEqual(first, retry)
        self.assertNotEqual(first, changed)
        self.assertRegex(first, r"^smtp-sha256-[0-9a-f]{64}$")
        self.assertLessEqual(len(first), 128)

    async def test_handle_data_reuses_the_key_when_an_mta_retries_same_data(self):
        client = _RecordingClient()
        handler = CustomSMTPHandler(client=client)
        session = SimpleNamespace(
            auth_data=LoginPassword(b"sender@example.com", b"signed-address-jwt"),
        )

        self.assertEqual(
            await handler.handle_DATA(None, session, _envelope(MESSAGE)),
            "250 OK",
        )
        self.assertEqual(
            await handler.handle_DATA(None, session, _envelope(MESSAGE)),
            "250 OK",
        )

        self.assertEqual(len(client.requests), 2)
        first_key = client.requests[0]["json"]["idempotency_key"]
        self.assertEqual(first_key, client.requests[1]["json"]["idempotency_key"])
        self.assertEqual(
            first_key,
            build_smtp_idempotency_key("sender@example.com", _envelope(MESSAGE)),
        )


if __name__ == "__main__":
    unittest.main()
