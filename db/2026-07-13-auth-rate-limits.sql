-- Always-on D1 password-login throttling. Keys contain SHA-256 account/IP
-- digests, not plaintext identifiers.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE auth_rate_limits
ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated_at
ON auth_rate_limits(updated_at);
