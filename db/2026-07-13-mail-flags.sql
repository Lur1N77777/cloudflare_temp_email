-- Persistent IMAP-style system flags. Only allowlisted flags are exposed by the
-- Worker API; the schema stores booleans to avoid arbitrary flag injection.
CREATE TABLE IF NOT EXISTS mail_flags (
    address_id INTEGER NOT NULL,
    mailbox TEXT NOT NULL,
    mail_id INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0, 1)),
    answered INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0, 1)),
    flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (address_id, mailbox, mail_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_flags_mail_id ON mail_flags(mail_id);
