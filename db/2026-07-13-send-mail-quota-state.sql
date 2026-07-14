-- Store the current daily/monthly counters in one row so both limits can be
-- reserved by one conditional statement. Safe to run before Worker rollout.
CREATE TABLE IF NOT EXISTS send_mail_quota_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    daily_period TEXT NOT NULL,
    daily_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_count >= 0),
    monthly_period TEXT NOT NULL,
    monthly_count INTEGER NOT NULL DEFAULT 0 CHECK (monthly_count >= 0),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Preserve the active counters when upgrading in the middle of a day/month.
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
