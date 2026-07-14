-- Strongly consistent registration-code reservation and one-time consumption.
-- Safe to apply before the corresponding Worker deployment.
CREATE TABLE IF NOT EXISTS registration_challenges (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE registration_challenges
ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_registration_challenges_expires_at
ON registration_challenges(expires_at);
