CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    raw_blob BLOB,
    metadata TEXT,
    delivery_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_delivery_key
ON raw_mails(delivery_key)
WHERE delivery_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_mails_address_id
ON raw_mails(address, id DESC);

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

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    token_version INTEGER NOT NULL DEFAULT 0,
    source_meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);

CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS send_mail_quota_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    daily_period TEXT NOT NULL,
    daily_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_count >= 0),
    monthly_period TEXT NOT NULL,
    monthly_count INTEGER NOT NULL DEFAULT 0 CHECK (monthly_count >= 0),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    in_flight INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated_at
ON auth_rate_limits(updated_at);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 0,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS registration_challenges (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_registration_challenges_expires_at
ON registration_challenges(expires_at);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);
