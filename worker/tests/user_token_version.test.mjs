import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
    buildUserTokenPayload,
    isUserTokenPayloadCurrent,
} from '../src/auth_tokens.ts';

test('user tokens are typed, bounded, and tied to the current credential version', () => {
    const now = 1_800_000_000;
    const user = { id: 7, user_email: 'owner@example.com', token_version: 3 };
    const payload = buildUserTokenPayload(user, now);

    assert.deepEqual(payload, {
        typ: 'user',
        sub: '7',
        user_email: 'owner@example.com',
        user_id: 7,
        token_version: 3,
        iat: now,
        exp: now + 30 * 24 * 60 * 60,
    });
    assert.equal(isUserTokenPayloadCurrent(payload, user, now + 1), true);
    assert.equal(isUserTokenPayloadCurrent({ ...payload, token_version: 2 }, user, now + 1), false);
    assert.equal(isUserTokenPayloadCurrent({ ...payload, sub: '8' }, user, now + 1), false);
    assert.equal(isUserTokenPayloadCurrent({ ...payload, exp: now }, user, now + 1), false);
});

test('legacy user tokens only survive while the database row remains version zero', () => {
    const now = 1_800_000_000;
    const legacy = {
        user_email: 'owner@example.com',
        user_id: 7,
        iat: now - 10,
        exp: now + 10,
    };
    assert.equal(isUserTokenPayloadCurrent(
        legacy,
        { id: 7, user_email: 'owner@example.com', token_version: 0 },
        now,
    ), true);
    assert.equal(isUserTokenPayloadCurrent(
        legacy,
        { id: 7, user_email: 'owner@example.com', token_version: 1 },
        now,
    ), false);
});

test('password reset migration can revoke every existing user session', () => {
    const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    const migration = readFileSync(
        new URL('../../db/2026-07-13-user-token-version.sql', import.meta.url),
        'utf8',
    );
    const admin = readFileSync(
        new URL('../src/admin_api/admin_user_api.ts', import.meta.url),
        'utf8',
    );
    assert.match(schema, /users \([\s\S]*?token_version INTEGER NOT NULL DEFAULT 0/);
    assert.match(migration, /ALTER TABLE users ADD COLUMN token_version/);
    assert.match(admin, /token_version = token_version \+ 1/);

    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, token_version INTEGER NOT NULL DEFAULT 0)');
    db.exec('INSERT INTO users (id) VALUES (1)');
    db.exec('UPDATE users SET token_version = token_version + 1 WHERE id = 1');
    assert.equal(db.prepare('SELECT token_version FROM users WHERE id = 1').get().token_version, 1);
});
