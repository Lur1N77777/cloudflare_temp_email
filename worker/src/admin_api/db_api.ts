import { Context } from "hono";
import { CONSTANTS } from "../constants";
import utils from "../utils";

export const DB_INIT_QUERIES = `
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
`

export default {
    initialize: async (c: Context<HonoCustomType>) => {
        // remove all \r and \n characters from the query string
        // split by ; and join with a ;\n
        const query = DB_INIT_QUERIES.replace(/[\r\n]/g, "")
            .split(";")
            .map((query) => query.trim())
            .join(";\n");
        await c.env.DB.exec(query);

        const version = await utils.getSetting(c, CONSTANTS.DB_VERSION_KEY);
        if (version) {
            return c.json({ message: "Database already initialized" });
        }
        await utils.saveSetting(c, CONSTANTS.DB_VERSION_KEY, CONSTANTS.DB_VERSION);
        return c.json({ message: "Database initialized" });
    },
    migrate: async (c: Context<HonoCustomType>) => {
        const version = await utils.getSetting(c, CONSTANTS.DB_VERSION_KEY);
        if (version && version <= "v0.0.2") {
            // migration to v0.0.3: add password column
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(address)`
            ).all();
            const hasPassword = tableInfo.results?.some(
                (col: any) => col.name === 'password'
            );
            if (!hasPassword) {
                await c.env.DB.exec(`ALTER TABLE address ADD COLUMN password TEXT;`);
            }
        }
        if (version && version <= "v0.0.3") {
            // migration to v0.0.4: add metadata column
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(raw_mails)`
            ).all();
            const hasMetadata = tableInfo.results?.some(
                (col: any) => col.name === 'metadata'
            );
            if (!hasMetadata) {
                await c.env.DB.exec(`ALTER TABLE raw_mails ADD COLUMN metadata TEXT;`);
            }
        }
        if (version && version <= "v0.0.4") {
            // migration to v0.0.5: add source_meta column
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(address)`
            ).all();
            const hasSourceMeta = tableInfo.results?.some(
                (col: any) => col.name === 'source_meta'
            );
            if (!hasSourceMeta) {
                await c.env.DB.exec(`ALTER TABLE address ADD COLUMN source_meta TEXT;`);
                await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);`);
            }
        }
        if (version && version <= "v0.0.5") {
            // migration to v0.0.6: add message_id index on raw_mails
            await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);`);
        }
        if (version && version <= "v0.0.6") {
            // migration to v0.0.7: add raw_blob column for gzip compressed email storage
            const tableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(raw_mails)`
            ).all();
            const hasRawBlob = tableInfo.results?.some(
                (col: any) => col.name === 'raw_blob'
            );
            if (!hasRawBlob) {
                await c.env.DB.exec(`ALTER TABLE raw_mails ADD COLUMN raw_blob BLOB;`);
            }
        }
        if (version && version <= "v0.0.7") {
            // migration to v0.0.8: atomic registration and outbound-mail reservations
            const addressTableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(address)`
            ).all();
            const hasTokenVersion = addressTableInfo.results?.some(
                (column: any) => column.name === 'token_version'
            );
            if (!hasTokenVersion) {
                await c.env.DB.exec(
                    `ALTER TABLE address ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;`
                );
            }
            const userTableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(users)`
            ).all();
            const userHasTokenVersion = userTableInfo.results?.some(
                (column: any) => column.name === 'token_version'
            );
            if (!userHasTokenVersion) {
                await c.env.DB.exec(
                    `ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;`
                );
            }
            const rawMailTableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(raw_mails)`
            ).all();
            const hasDeliveryKey = rawMailTableInfo.results?.some(
                (column: any) => column.name === 'delivery_key'
            );
            if (!hasDeliveryKey) {
                await c.env.DB.exec(
                    `ALTER TABLE raw_mails ADD COLUMN delivery_key TEXT;`
                );
            }
            await c.env.DB.exec(`
                DROP INDEX IF EXISTS idx_raw_mails_delivery_key;
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
                CREATE TABLE IF NOT EXISTS send_mail_quota_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    daily_period TEXT NOT NULL,
                    daily_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_count >= 0),
                    monthly_period TEXT NOT NULL,
                    monthly_count INTEGER NOT NULL DEFAULT 0 CHECK (monthly_count >= 0),
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO send_mail_quota_state (
                    singleton, daily_period, daily_count, monthly_period, monthly_count
                ) VALUES (
                    1,
                    strftime('%Y-%m-%d', 'now'),
                    MAX(COALESCE(CAST((
                        SELECT value FROM settings
                        WHERE key = 'send_mail_limit_count:daily:' || strftime('%Y-%m-%d', 'now')
                    ) AS INTEGER), 0), 0),
                    strftime('%Y-%m', 'now'),
                    MAX(COALESCE(CAST((
                        SELECT value FROM settings
                        WHERE key = 'send_mail_limit_count:monthly:' || strftime('%Y-%m', 'now')
                    ) AS INTEGER), 0), 0)
                ) ON CONFLICT(singleton) DO NOTHING;
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
            `);
            const challengeTableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(registration_challenges)`
            ).all();
            const challengeHasAttempts = challengeTableInfo.results?.some(
                (column: any) => column.name === 'attempts'
            );
            if (!challengeHasAttempts) {
                await c.env.DB.exec(
                    `ALTER TABLE registration_challenges ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;`
                );
            }
            const rateLimitTableInfo = await c.env.DB.prepare(
                `PRAGMA table_info(auth_rate_limits)`
            ).all();
            const rateLimitHasInFlight = rateLimitTableInfo.results?.some(
                (column: any) => column.name === 'in_flight'
            );
            if (!rateLimitHasInFlight) {
                await c.env.DB.exec(
                    `ALTER TABLE auth_rate_limits ADD COLUMN in_flight INTEGER NOT NULL DEFAULT 0;`
                );
            }
        }
        if (version != CONSTANTS.DB_VERSION) {
            // remove all \r and \n characters from the query string
            // split by ; and join with a ;\n
            const query = DB_INIT_QUERIES.replace(/[\r\n]/g, "")
                .split(";")
                .map((query) => query.trim())
                .join(";\n");
            await c.env.DB.exec(query);
            // Update the version in the settings table
            await utils.saveSetting(c, CONSTANTS.DB_VERSION_KEY, CONSTANTS.DB_VERSION);
            return c.json({
                success: true,
                message: "Database migrated"
            });
        }
        return c.json({
            success: true,
            message: "Database does not need migration"
        });
    },
    getVersion: async (c: Context<HonoCustomType>) => {
        const version = await utils.getSetting(c, CONSTANTS.DB_VERSION_KEY);
        return c.json({
            need_initialization: !version,
            need_migration: version && version != CONSTANTS.DB_VERSION,
            current_db_version: version,
            code_db_version: CONSTANTS.DB_VERSION
        });
    },
}
