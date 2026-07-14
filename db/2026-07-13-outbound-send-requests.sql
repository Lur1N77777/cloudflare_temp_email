-- Claim outbound requests before quota reservation/provider delivery so
-- concurrent retries cannot send or charge twice. Terminal rows are retained
-- as the idempotency result for later retries using the same key.
CREATE TABLE IF NOT EXISTS outbound_send_requests (
    address TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    PRIMARY KEY (address, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbound_send_requests_updated_at
ON outbound_send_requests(updated_at);
