import bisect
import logging
import time
from collections import OrderedDict

from twisted.internet import defer
from twisted.mail import imap4
from zope.interface import implementer

from config import settings
from imap_http_client import BackendClient
from imap_message import SimpleMessage
from parse_email import generate_email_model, parse_email, clean_raw_headers, fix_mojibake

_logger = logging.getLogger(__name__)
_logger.setLevel(logging.INFO)

# Use process start time as UIDVALIDITY so clients resync after restart
_UID_VALIDITY = int(time.time())


class MessageCache:
    """LRU cache for parsed email messages, keyed by backend id (=UID)."""

    def __init__(self, max_size: int = 500):
        self._cache: OrderedDict[int, SimpleMessage] = OrderedDict()
        self._max_size = max_size

    def get(self, uid: int):
        if uid in self._cache:
            self._cache.move_to_end(uid)
            return self._cache[uid]
        return None

    def put(self, uid: int, message: SimpleMessage):
        if uid in self._cache:
            self._cache.move_to_end(uid)
            self._cache[uid] = message
        else:
            if len(self._cache) >= self._max_size:
                self._cache.popitem(last=False)
            self._cache[uid] = message

    def __contains__(self, uid: int) -> bool:
        return uid in self._cache

    def __len__(self) -> int:
        return len(self._cache)


@implementer(imap4.IMailboxInfo, imap4.IMailbox, imap4.ISearchableMailbox)
class SimpleMailbox:

    def __init__(self, name: str, client: BackendClient):
        self.name = name
        self._client = client
        self.listeners = []
        self.addListener = self.listeners.append
        self.removeListener = self.listeners.remove
        self._message_count = 0
        self._uid_index: list[int] = []
        self._flags: dict[int, set[str]] = {}
        self._cache = MessageCache(max_size=settings.imap_cache_size)
        self._uid_index_built = False

    def getFlags(self):
        return [r"\Seen", r"\Answered", r"\Flagged", r"\Deleted", r"\Draft"]

    def getUIDValidity(self):
        return _UID_VALIDITY

    def getMessageCount(self):
        return self._message_count

    def getRecentCount(self):
        return 0

    def getUnseenCount(self):
        return sum(
            1 for uid in self._uid_index
            if r"\Seen" not in self._flags.get(uid, set())
        )

    def isWriteable(self):
        return 1

    def destroy(self):
        pass

    def getHierarchicalDelimiter(self):
        return "/"

    @defer.inlineCallbacks
    def requestStatus(self, names):
        if not self._uid_index_built:
            yield self._build_uid_index()
        else:
            count, newest_id = yield self._refresh_state()
            if self._mailbox_changed(count, newest_id):
                yield self._build_uid_index()
        if "UNSEEN" in names:
            yield self._refresh_flags(self._uid_index)

        r = {}
        if "MESSAGES" in names:
            r["MESSAGES"] = self._message_count
        if "RECENT" in names:
            r["RECENT"] = self.getRecentCount()
        if "UIDNEXT" in names:
            r["UIDNEXT"] = self.getUIDNext()
        if "UIDVALIDITY" in names:
            r["UIDVALIDITY"] = self.getUIDValidity()
        if "UNSEEN" in names:
            r["UNSEEN"] = self.getUnseenCount()
        return r

    def _refresh_state(self) -> defer.Deferred:
        return self._client.get_mailbox_state(self.name)

    def _mailbox_changed(self, count: int, newest_id: int | None) -> bool:
        indexed_newest = self._uid_index[-1] if self._uid_index else None
        return count != self._message_count or newest_id != indexed_newest

    @defer.inlineCallbacks
    def _build_uid_index(self):
        """Build the UID index from lightweight, stable cursor pages."""
        uid_set = set()
        batch_size = 200
        before_id = None
        reported_count = 0

        while True:
            results, count, next_cursor = yield self._client.get_mail_ids(
                self.name, batch_size, before_id
            )
            if before_id is None:
                reported_count = count
                _logger.info(
                    "Building UID index for %s: count=%d",
                    self.name, reported_count,
                )
            for item in results:
                item_id = item.get("id")
                if isinstance(item_id, int) and item_id > 0:
                    uid_set.add(item_id)
            _logger.info(
                "UID index page: before_id=%s got=%d total_uids=%d",
                before_id, len(results), len(uid_set),
            )
            if next_cursor is None:
                break
            if (
                not isinstance(next_cursor, int)
                or next_cursor <= 0
                or (before_id is not None and next_cursor >= before_id)
            ):
                raise ValueError("Backend returned an invalid mail cursor")
            before_id = next_cursor

        self._uid_index = sorted(uid_set)
        self._message_count = len(self._uid_index)
        if reported_count != self._message_count:
            _logger.info(
                "Mailbox %s changed during UID sync: reported=%d indexed=%d",
                self.name, reported_count, self._message_count,
            )
        yield self._load_flags()
        self._uid_index_built = True
        _logger.info(
            "UID index built for %s: %d UIDs, range=%s..%s",
            self.name, len(self._uid_index),
            self._uid_index[0] if self._uid_index else "N/A",
            self._uid_index[-1] if self._uid_index else "N/A",
        )

    @defer.inlineCallbacks
    def _load_flags(self):
        """Load persisted flags for the current UID index."""
        self._flags = {}
        yield self._refresh_flags(self._uid_index)

    @defer.inlineCallbacks
    def _refresh_flags(self, uids: list[int]):
        """Refresh persisted flags for a bounded set of UIDs."""
        unique_uids = list(dict.fromkeys(uids))
        refreshed = {mail_id: set() for mail_id in unique_uids}
        allowed = set(self.getFlags())
        batch_size = 90
        for start in range(0, len(unique_uids), batch_size):
            batch = unique_uids[start:start + batch_size]
            batch_set = set(batch)
            rows = yield self._client.get_flags(self.name, batch)
            for row in rows:
                mail_id = row.get("mail_id")
                if mail_id not in batch_set:
                    continue
                values = row.get("flags", [])
                if not isinstance(values, list):
                    continue
                refreshed[mail_id] = {
                    flag for flag in values
                    if isinstance(flag, str) and flag in allowed
                }
        for mail_id, flags in refreshed.items():
            self._flags[mail_id] = flags
            cached = self._cache.get(mail_id)
            if cached is not None:
                cached._flags = flags

    def _seq_to_uid(self, seq: int) -> int | None:
        """Convert 1-based sequence number to UID."""
        if 1 <= seq <= len(self._uid_index):
            return self._uid_index[seq - 1]
        return None

    def _uid_to_seq(self, uid: int) -> int | None:
        """Convert UID to 1-based sequence number."""
        idx = bisect.bisect_left(self._uid_index, uid)
        if idx < len(self._uid_index) and self._uid_index[idx] == uid:
            return idx + 1
        return None

    def _resolve_message_set(self, messages, uid: bool) -> list[int]:
        """Resolve an IMAP MessageSet to a list of UIDs."""
        result_uids = []
        if not self._uid_index:
            return result_uids

        max_uid = self._uid_index[-1]
        max_seq = len(self._uid_index)

        _logger.info(
            "Resolving message_set: uid=%s ranges=%s max_uid=%d max_seq=%d",
            uid, list(messages.ranges), max_uid, max_seq,
        )

        for start, end in messages.ranges:
            if uid:
                actual_end = end if end is not None else max_uid
                for u in self._uid_index:
                    if start <= u <= actual_end:
                        result_uids.append(u)
            else:
                actual_end = end if end is not None else max_seq
                actual_start = max(start, 1)
                actual_end = min(actual_end, max_seq)
                for seq in range(actual_start, actual_end + 1):
                    u = self._seq_to_uid(seq)
                    if u is not None:
                        result_uids.append(u)

        return result_uids

    @defer.inlineCallbacks
    def _fetch_and_cache_messages(self, uids: list[int]):
        """Fetch uncached messages from backend in batches."""
        uncached = [u for u in uids if u not in self._cache]
        if not uncached:
            return

        id_to_data = {}
        batch_size = 10

        _logger.info(
            "Fetching %d uncached messages by ID for %s",
            len(uncached), self.name,
        )

        for start in range(0, len(uncached), batch_size):
            batch = uncached[start:start + batch_size]
            batch_ids = set(batch)
            results = yield self._client.get_mail_details(self.name, batch)
            for item in results:
                item_id = item.get("id")
                if item_id in batch_ids:
                    id_to_data[item_id] = item

        _logger.info(
            "Fetched %d/%d messages for %s",
            len(id_to_data), len(uncached), self.name,
        )

        for uid_val in uncached:
            if uid_val in id_to_data:
                item = id_to_data[uid_val]
                try:
                    if self.name == "INBOX":
                        raw = item.get("raw", "")
                        raw = fix_mojibake(raw)
                        raw = clean_raw_headers(raw)
                        email_model = parse_email(raw)
                    elif self.name == "SENT":
                        email_model, raw = generate_email_model(item)
                    else:
                        continue

                    if uid_val not in self._flags:
                        self._flags[uid_val] = set()
                    flags = self._flags[uid_val]
                    msg = SimpleMessage(
                        uid_val, email_model, flags=flags, raw=raw,
                        created_at=item.get("created_at"),
                    )
                    self._cache.put(uid_val, msg)
                except Exception as e:
                    _logger.error(f"Failed to parse message uid={uid_val}: {e}")

    @defer.inlineCallbacks
    def fetch(self, messages, uid):
        if not self._uid_index_built:
            yield self._build_uid_index()
        else:
            count, newest_id = yield self._refresh_state()
            if self._mailbox_changed(count, newest_id):
                yield self._build_uid_index()

        target_uids = self._resolve_message_set(messages, uid)
        _logger.info(
            "FETCH: uid=%s target_uids=%d message_set=%s",
            uid, len(target_uids),
            target_uids[:5] if len(target_uids) > 5 else target_uids,
        )
        if not target_uids:
            return []

        yield self._refresh_flags(target_uids)
        yield self._fetch_and_cache_messages(target_uids)

        result = []
        for u in target_uids:
            cached = self._cache.get(u)
            if cached is not None:
                flags = self._flags.get(u, set())
                cached._flags = flags
                seq = self._uid_to_seq(u)
                if seq is not None:
                    result.append((seq, cached))

        return result

    def getUID(self, message):
        return message

    @defer.inlineCallbacks
    def store(self, messages, flags, mode, uid):
        if not self._uid_index_built:
            yield self._build_uid_index()
        if not self._uid_index:
            return {}

        target_uids = self._resolve_message_set(messages, uid)
        result = {}
        yield self._refresh_flags(target_uids)
        allowed = set(self.getFlags())
        requested_flags = {
            flag.decode("ascii") if isinstance(flag, bytes) else flag
            for flag in flags
        }
        if not requested_flags.issubset(allowed):
            raise ValueError("Unsupported IMAP flag")
        if mode == 1:
            operation = "add"
        elif mode == -1:
            operation = "remove"
        elif mode == 0:
            operation = "replace"
        else:
            raise ValueError("Unsupported IMAP flag operation")

        updates = []
        for u in target_uids:
            current_flags = self._flags.get(u, set())

            if mode == 1:    # +FLAGS
                current_flags = current_flags | requested_flags
            elif mode == -1:  # -FLAGS
                current_flags = current_flags - requested_flags
            else:             # FLAGS (replace)
                current_flags = set(requested_flags)

            updates.append({
                "mail_id": u,
                "operation": operation,
                "flags": sorted(
                    current_flags if operation == "replace"
                    else requested_flags
                ),
            })

        for start in range(0, len(updates), 40):
            yield self._client.patch_flags(
                self.name, updates[start:start + 40]
            )

        yield self._refresh_flags(target_uids)
        for u in target_uids:
            current_flags = self._flags.get(u, set())
            seq = self._uid_to_seq(u)
            if seq is not None:
                result[seq] = current_flags

        return result

    @defer.inlineCallbacks
    def search(self, query, uid):
        if not self._uid_index_built:
            yield self._build_uid_index()

        results = []

        for term in query:
            if isinstance(term, str) and term.upper() == "ALL":
                if uid:
                    results = list(self._uid_index)
                else:
                    results = list(range(1, len(self._uid_index) + 1))
                break

        if not results:
            if uid:
                results = list(self._uid_index)
            else:
                results = list(range(1, len(self._uid_index) + 1))

        return results

    def getUIDNext(self):
        if self._uid_index:
            return self._uid_index[-1] + 1
        return 1

    def expunge(self):
        return defer.succeed([])
