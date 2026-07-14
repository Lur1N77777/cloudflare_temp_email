import logging

import httpx
from twisted.internet import defer, threads

from config import settings

_logger = logging.getLogger(__name__)
_logger.setLevel(logging.INFO)


class BackendClient:
    """Async HTTP client for IMAP backend communication.

    All public methods return Deferred via deferToThread to avoid
    blocking the Twisted reactor with synchronous HTTP calls.
    """

    def __init__(self, password: str):
        self.password = password.strip()
        self._client = httpx.Client(
            base_url=settings.proxy_url,
            headers={
                "Authorization": f"Bearer {password}",
                "x-custom-auth": settings.basic_password,
                "Content-Type": "application/json",
            },
            timeout=settings.imap_http_timeout,
        )

    @staticmethod
    def _validate_mailbox(mailbox_name: str) -> None:
        if mailbox_name not in {"INBOX", "SENT"}:
            raise ValueError(f"Unknown mailbox: {mailbox_name}")

    def _sync_get_mailbox_state(
        self, mailbox_name: str
    ) -> tuple[int, int | None]:
        self._validate_mailbox(mailbox_name)
        res = self._client.get(
            "/api/mail_ids",
            params={"mailbox": mailbox_name, "limit": 1},
        )
        res.raise_for_status()
        data = res.json()
        results = data.get("results", [])
        newest_id = results[0].get("id") if results else None
        return int(data.get("count") or 0), newest_id

    def _sync_get_mail_ids(
        self, mailbox_name: str, limit: int, before_id: int | None = None
    ) -> tuple[list[dict], int, int | None]:
        self._validate_mailbox(mailbox_name)
        if limit < 1 or limit > 200:
            raise ValueError("Mail ID page size must be between 1 and 200")
        params = {"mailbox": mailbox_name, "limit": limit}
        if before_id is not None:
            if before_id <= 0:
                raise ValueError("Mail cursor must be positive")
            params["before_id"] = before_id
        res = self._client.get("/api/mail_ids", params=params)
        res.raise_for_status()
        data = res.json()
        return (
            data.get("results", []),
            int(data.get("count") or 0),
            data.get("next_cursor"),
        )

    def _sync_get_mail_details(
        self, mailbox_name: str, mail_ids: list[int]
    ) -> list[dict]:
        self._validate_mailbox(mailbox_name)
        if not mail_ids:
            return []
        if (
            len(mail_ids) > 10
            or len(set(mail_ids)) != len(mail_ids)
            or any(mail_id <= 0 for mail_id in mail_ids)
        ):
            raise ValueError("Invalid mail detail IDs")
        res = self._client.get(
            "/api/mail_details",
            params={
                "mailbox": mailbox_name,
                "mail_ids": ",".join(str(mail_id) for mail_id in mail_ids),
            },
        )
        res.raise_for_status()
        return res.json().get("results", [])

    def _sync_get_flags(
        self, mailbox_name: str, mail_ids: list[int]
    ) -> list[dict]:
        self._validate_mailbox(mailbox_name)
        if not mail_ids:
            return []
        if (
            len(mail_ids) > 90
            or len(set(mail_ids)) != len(mail_ids)
            or any(mail_id <= 0 for mail_id in mail_ids)
        ):
            raise ValueError("Invalid mail flag IDs")
        res = self._client.get(
            "/api/mail_flags",
            params={
                "mailbox": mailbox_name,
                "mail_ids": ",".join(str(mail_id) for mail_id in mail_ids),
            },
        )
        res.raise_for_status()
        return res.json().get("results", [])

    def _sync_patch_flags(
        self, mailbox_name: str, updates: list[dict]
    ) -> None:
        self._validate_mailbox(mailbox_name)
        if not updates or len(updates) > 40:
            raise ValueError("Invalid mail flag updates")
        res = self._client.patch(
            "/api/mail_flags",
            json={"mailbox": mailbox_name, "updates": updates},
        )
        res.raise_for_status()

    def get_mailbox_state(self, mailbox_name: str) -> defer.Deferred:
        return threads.deferToThread(
            self._sync_get_mailbox_state, mailbox_name
        )

    def get_mail_ids(
        self, mailbox_name: str, limit: int, before_id: int | None = None
    ) -> defer.Deferred:
        return threads.deferToThread(
            self._sync_get_mail_ids, mailbox_name, limit, before_id
        )

    def get_mail_details(
        self, mailbox_name: str, mail_ids: list[int]
    ) -> defer.Deferred:
        return threads.deferToThread(
            self._sync_get_mail_details, mailbox_name, mail_ids
        )

    def get_flags(
        self, mailbox_name: str, mail_ids: list[int]
    ) -> defer.Deferred:
        return threads.deferToThread(
            self._sync_get_flags, mailbox_name, mail_ids
        )

    def patch_flags(
        self, mailbox_name: str, updates: list[dict]
    ) -> defer.Deferred:
        return threads.deferToThread(
            self._sync_patch_flags, mailbox_name, updates
        )

    def close(self):
        self._client.close()
