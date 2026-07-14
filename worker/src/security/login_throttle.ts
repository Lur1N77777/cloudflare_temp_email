import type { Context } from 'hono';

const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_CONCURRENT_LOGIN_ATTEMPTS = 5;

const sha256Hex = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
};

export const buildLoginThrottleKeys = async (
    scope: 'user' | 'address',
    account: string,
    ipAddress: string,
): Promise<[string, string]> => {
    const [accountHash, ipHash] = await Promise.all([
        sha256Hex(account.trim().toLowerCase()),
        sha256Hex(ipAddress.trim().toLowerCase()),
    ]);
    return [
        `login:${scope}:account:${accountHash}`,
        `login:${scope}:ip:${ipHash}`,
    ];
};

export const LOGIN_ATTEMPT_RESERVE_SQL = `
    INSERT INTO auth_rate_limits (
        key, window_start, attempts, in_flight, blocked_until, updated_at
    ) VALUES (?, unixepoch(), 0, 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
        window_start = CASE
            WHEN auth_rate_limits.window_start <= unixepoch() - ${LOGIN_WINDOW_SECONDS} THEN unixepoch()
            ELSE auth_rate_limits.window_start
        END,
        attempts = CASE
            WHEN auth_rate_limits.window_start <= unixepoch() - ${LOGIN_WINDOW_SECONDS} THEN 0
            ELSE auth_rate_limits.attempts
        END,
        in_flight = CASE
            WHEN auth_rate_limits.window_start <= unixepoch() - ${LOGIN_WINDOW_SECONDS} THEN 1
            ELSE auth_rate_limits.in_flight + 1
        END,
        blocked_until = CASE
            WHEN auth_rate_limits.window_start <= unixepoch() - ${LOGIN_WINDOW_SECONDS} THEN 0
            ELSE auth_rate_limits.blocked_until
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE (
        auth_rate_limits.window_start <= unixepoch() - ${LOGIN_WINDOW_SECONDS}
        OR auth_rate_limits.blocked_until <= unixepoch()
    ) AND (
        auth_rate_limits.window_start <= unixepoch() - ${LOGIN_WINDOW_SECONDS}
        OR auth_rate_limits.in_flight < ${MAX_CONCURRENT_LOGIN_ATTEMPTS}
    )
    RETURNING attempts, in_flight, blocked_until
`;

export const LOGIN_FAILURE_FINALIZE_SQL = `
    UPDATE auth_rate_limits SET
        attempts = attempts + 1,
        in_flight = MAX(in_flight - 1, 0),
        blocked_until = CASE
            WHEN attempts + 1 < ${MAX_CONCURRENT_LOGIN_ATTEMPTS} THEN 0
            WHEN attempts + 1 = ${MAX_CONCURRENT_LOGIN_ATTEMPTS} THEN unixepoch() + 30
            WHEN attempts + 1 = ${MAX_CONCURRENT_LOGIN_ATTEMPTS + 1} THEN unixepoch() + 60
            WHEN attempts + 1 = ${MAX_CONCURRENT_LOGIN_ATTEMPTS + 2} THEN unixepoch() + 120
            WHEN attempts + 1 = ${MAX_CONCURRENT_LOGIN_ATTEMPTS + 3} THEN unixepoch() + 300
            ELSE unixepoch() + 900
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE key = ? AND in_flight > 0
    RETURNING attempts, in_flight, blocked_until
`;

// Kept as a compatibility export for integrations that used the previous name.
export const LOGIN_FAILURE_UPSERT_SQL = LOGIN_FAILURE_FINALIZE_SQL;

export const LOGIN_SUCCESS_FINALIZE_SQL = `
    UPDATE auth_rate_limits SET
        in_flight = MAX(in_flight - 1, 0),
        updated_at = CURRENT_TIMESTAMP
    WHERE key = ? AND in_flight > 0
`;

export const LOGIN_ACCOUNT_SUCCESS_FINALIZE_SQL = `
    UPDATE auth_rate_limits SET
        attempts = 0,
        in_flight = MAX(in_flight - 1, 0),
        blocked_until = 0,
        window_start = unixepoch(),
        updated_at = CURRENT_TIMESTAMP
    WHERE key = ? AND in_flight > 0
`;

const getClientIp = (c: Context<HonoCustomType>): string => {
    return c.req.header('cf-connecting-ip')
        || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        || 'unknown';
};

const getKeys = (
    c: Context<HonoCustomType>,
    scope: 'user' | 'address',
    account: string,
): Promise<[string, string]> => buildLoginThrottleKeys(scope, account, getClientIp(c));

export const checkLoginThrottle = async (
    c: Context<HonoCustomType>,
    scope: 'user' | 'address',
    account: string,
): Promise<{ allowed: boolean; retryAfter: number }> => {
    const keys = await getKeys(c, scope, account);
    const results = await c.env.DB.batch(keys.map((key) => c.env.DB.prepare(
        LOGIN_ATTEMPT_RESERVE_SQL
    ).bind(key)));
    if (!results.every((result) => result.success)) {
        throw new Error('Failed to reserve login throttling state');
    }

    const reserved = results.map((result) => Boolean(result.results?.length));
    if (reserved.every(Boolean)) return { allowed: true, retryAfter: 0 };

    const releases = keys
        .filter((_, index) => reserved[index])
        .map((key) => c.env.DB.prepare(LOGIN_SUCCESS_FINALIZE_SQL).bind(key));
    if (releases.length) await c.env.DB.batch(releases);

    const blocked = await c.env.DB.batch(keys.map((key) => c.env.DB.prepare(
        `SELECT blocked_until FROM auth_rate_limits WHERE key = ?`
    ).bind(key)));
    const now = Math.floor(Date.now() / 1000);
    const retryAfter = blocked.reduce((maximum, result) => {
        const row = result.results?.[0] as { blocked_until?: number } | undefined;
        return Math.max(maximum, Number(row?.blocked_until || 0) - now);
    }, 1);
    return { allowed: false, retryAfter };
};

export const recordLoginFailure = async (
    c: Context<HonoCustomType>,
    scope: 'user' | 'address',
    account: string,
): Promise<void> => {
    const keys = await getKeys(c, scope, account);
    const results = await c.env.DB.batch([
        ...keys.map((key) => c.env.DB.prepare(LOGIN_FAILURE_FINALIZE_SQL).bind(key)),
        c.env.DB.prepare(
            `DELETE FROM auth_rate_limits`
            + ` WHERE in_flight = 0 AND updated_at < datetime('now', '-1 day')`
        ),
    ]);
    if (!results.every((result) => result.success)) {
        throw new Error('Failed to persist login throttling state');
    }
};

export const clearAccountLoginFailures = async (
    c: Context<HonoCustomType>,
    scope: 'user' | 'address',
    account: string,
): Promise<void> => {
    const [accountKey, ipKey] = await getKeys(c, scope, account);
    const results = await c.env.DB.batch([
        c.env.DB.prepare(LOGIN_ACCOUNT_SUCCESS_FINALIZE_SQL).bind(accountKey),
        c.env.DB.prepare(LOGIN_SUCCESS_FINALIZE_SQL).bind(ipKey),
    ]);
    if (!results.every((result) => result.success)) {
        throw new Error('Failed to finalize login throttling state');
    }
};
