-- Existing rows remain valid with a NULL key. New deliveries receive a
-- deterministic key in the Worker and are deduplicated atomically by D1.
ALTER TABLE raw_mails ADD COLUMN delivery_key TEXT;

-- Replace the earlier non-unique lookup index if it was applied during
-- pre-release testing under the same name.
DROP INDEX IF EXISTS idx_raw_mails_delivery_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_delivery_key
ON raw_mails(delivery_key)
WHERE delivery_key IS NOT NULL;

-- Supports lightweight keyset pagination for IMAP and API clients.
CREATE INDEX IF NOT EXISTS idx_raw_mails_address_id
ON raw_mails(address, id DESC);
