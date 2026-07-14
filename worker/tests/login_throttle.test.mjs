import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
    LOGIN_ATTEMPT_RESERVE_SQL,
    LOGIN_FAILURE_FINALIZE_SQL,
    MAX_CONCURRENT_LOGIN_ATTEMPTS,
    buildLoginThrottleKeys,
} from '../src/security/login_throttle.ts';

test('login throttle keys protect both account and IP without storing either in plaintext', async () => {
    const keys = await buildLoginThrottleKeys('user', 'Alice@Example.com', '203.0.113.4');
    assert.equal(keys.length, 2);
    assert.equal(keys.some((key) => key.includes('alice@example.com')), false);
    assert.equal(keys.some((key) => key.includes('203.0.113.4')), false);
    assert.match(keys[0], /^login:user:account:[a-f0-9]{64}$/);
    assert.match(keys[1], /^login:user:ip:[a-f0-9]{64}$/);
});

test('login attempts are reserved before password work and concurrent bursts are bounded', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE auth_rate_limits (
            key TEXT PRIMARY KEY,
            window_start INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            in_flight INTEGER NOT NULL DEFAULT 0,
            blocked_until INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const reserve = db.prepare(LOGIN_ATTEMPT_RESERVE_SQL);
    const finalizeFailure = db.prepare(LOGIN_FAILURE_FINALIZE_SQL);
    const key = 'login:user:account:test';

    for (let index = 1; index <= MAX_CONCURRENT_LOGIN_ATTEMPTS; index += 1) {
        const row = reserve.get(key);
        assert.equal(row.in_flight, index);
        assert.equal(row.attempts, 0);
    }
    assert.equal(reserve.get(key), undefined);

    for (let index = 1; index <= MAX_CONCURRENT_LOGIN_ATTEMPTS; index += 1) {
        const row = finalizeFailure.get(key);
        assert.equal(row.attempts, index);
        assert.equal(row.in_flight, MAX_CONCURRENT_LOGIN_ATTEMPTS - index);
    }
    const row = db.prepare(
        'SELECT attempts, in_flight, blocked_until FROM auth_rate_limits WHERE key = ?',
    ).get(key);
    assert.equal(row.attempts, MAX_CONCURRENT_LOGIN_ATTEMPTS);
    assert.equal(row.in_flight, 0);
    assert.ok(row.blocked_until > Math.floor(Date.now() / 1000));
});

test('both password handlers record failures and clear the account key on success', () => {
    const userSource = readFileSync(new URL('../src/user_api/user.ts', import.meta.url), 'utf8');
    const addressSource = readFileSync(
        new URL('../src/mails_api/address_auth.ts', import.meta.url),
        'utf8',
    );
    for (const source of [userSource, addressSource]) {
        assert.match(source, /checkLoginThrottle\(/);
        assert.match(source, /recordLoginFailure\(/);
        assert.match(source, /clearAccountLoginFailures\(/);
    }
});
