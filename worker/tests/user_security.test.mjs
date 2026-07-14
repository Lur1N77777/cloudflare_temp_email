import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
    hashUserPassword,
    isPasswordHash,
    verifyUserPassword,
} from '../src/security/user_password.ts';
import {
    MAX_REGISTRATION_ATTEMPTS,
    REGISTRATION_CHALLENGE_FAILURE_SQL,
    REGISTRATION_CHALLENGE_RESERVE_SQL,
    generateRegistrationCode,
    normalizeUserEmail,
} from '../src/user_api/registration_security.ts';

test('PBKDF2 password hashes are salted, versioned and not replayable', async () => {
    const suppliedPassword = 'a'.repeat(64);
    const firstHash = await hashUserPassword(suppliedPassword);
    const secondHash = await hashUserPassword(suppliedPassword);

    assert.equal(isPasswordHash(firstHash), true);
    assert.equal(isPasswordHash(secondHash), true);
    assert.notEqual(firstHash, secondHash);
    assert.equal((await verifyUserPassword(firstHash, suppliedPassword)).valid, true);
    assert.equal((await verifyUserPassword(firstHash, 'b'.repeat(64))).valid, false);
});

test('legacy replayable passwords authenticate once and request migration', async () => {
    const legacyPassword = 'legacy-client-sha256';

    assert.deepEqual(await verifyUserPassword(legacyPassword, legacyPassword), {
        valid: true,
        needsUpgrade: true,
    });
    assert.deepEqual(await verifyUserPassword(legacyPassword, 'wrong'), {
        valid: false,
        needsUpgrade: false,
    });
});

test('malformed versioned hashes fail closed instead of becoming replayable legacy values', async () => {
    const malformed = 'pbkdf2-sha256$v=1$i=310000$broken$broken';
    assert.deepEqual(await verifyUserPassword(malformed, malformed), {
        valid: false,
        needsUpgrade: false,
    });
});

test('registration email identity is canonical and invalid input is rejected', () => {
    assert.equal(normalizeUserEmail('  Alice@Example.COM  '), 'alice@example.com');
    assert.throws(() => normalizeUserEmail('not-an-email'));
    assert.throws(() => normalizeUserEmail('a@@example.com'));
});

test('OAuth identities use the same canonical email boundary', () => {
    const oauthSource = readFileSync(new URL('../src/user_api/oauth2.ts', import.meta.url), 'utf8');
    assert.match(oauthSource, /normalizeUserEmail\(formattedEmail\)/);
    assert.match(oauthSource, /user_email = \? COLLATE NOCASE/);
});

test('verification codes use WebCrypto and always have six digits', () => {
    const originalRandom = Math.random;
    Math.random = () => {
        throw new Error('Math.random must not be used for security codes');
    };
    try {
        for (let index = 0; index < 100; index += 1) {
            assert.match(generateRegistrationCode(), /^\d{6}$/);
        }
    } finally {
        Math.random = originalRandom;
    }
});

test('D1 registration challenge reservation permits only one live sender', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            user_email TEXT UNIQUE NOT NULL
        );
        CREATE TABLE registration_challenges (
            email TEXT PRIMARY KEY COLLATE NOCASE,
            code TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const reserve = db.prepare(REGISTRATION_CHALLENGE_RESERVE_SQL);
    assert.equal(reserve.run('alice@example.com', '111111', 300, 'alice@example.com').changes, 1);
    assert.equal(reserve.run('ALICE@example.com', '222222', 300, 'ALICE@example.com').changes, 0);
    assert.equal(
        db.prepare('SELECT code FROM registration_challenges WHERE email = ?')
            .get('alice@example.com').code,
        '111111',
    );
    db.prepare('INSERT INTO users (user_email) VALUES (?)').run('registered@example.com');
    assert.equal(reserve.run(
        'REGISTERED@example.com', '333333', 300, 'REGISTERED@example.com',
    ).changes, 0);
});

test('wrong registration codes are counted atomically and lock the challenge', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            user_email TEXT UNIQUE NOT NULL
        );
        CREATE TABLE registration_challenges (
            email TEXT PRIMARY KEY COLLATE NOCASE,
            code TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const reserve = db.prepare(REGISTRATION_CHALLENGE_RESERVE_SQL);
    const recordFailure = db.prepare(REGISTRATION_CHALLENGE_FAILURE_SQL);
    reserve.run('alice@example.com', '111111', 300, 'alice@example.com');

    for (let attempt = 1; attempt <= MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
        const row = recordFailure.get(
            MAX_REGISTRATION_ATTEMPTS,
            'alice@example.com',
            '000000',
        );
        assert.equal(row.attempts, attempt);
        assert.equal(Boolean(row.consumed_at), attempt === MAX_REGISTRATION_ATTEMPTS);
    }
    assert.equal(
        recordFailure.get(MAX_REGISTRATION_ATTEMPTS, 'alice@example.com', '000000'),
        undefined,
    );

    db.prepare(`
        UPDATE registration_challenges
        SET expires_at = unixepoch() - 1
        WHERE email = ?
    `).run('alice@example.com');
    assert.equal(
        reserve.run('alice@example.com', '222222', 300, 'alice@example.com').changes,
        1,
    );
    assert.equal(
        db.prepare('SELECT attempts FROM registration_challenges WHERE email = ?')
            .get('alice@example.com').attempts,
        0,
    );
});

test('user and admin account flows enforce the password and registration primitives', () => {
    const userSource = readFileSync(new URL('../src/user_api/user.ts', import.meta.url), 'utf8');
    const adminSource = readFileSync(new URL('../src/admin_api/admin_user_api.ts', import.meta.url), 'utf8');
    const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');

    assert.match(userSource, /hashUserPassword\(password\)/);
    assert.match(userSource, /verifyUserPassword\([^,]+, password\)/);
    assert.match(userSource, /REGISTRATION_CHALLENGE_RESERVE_SQL/);
    assert.match(userSource, /REGISTRATION_CHALLENGE_FAILURE_SQL/);
    assert.match(userSource, /c\.env\.DB\.batch\(/);
    assert.match(userSource, /return c\.json\(\{ success: true, jwt \}\)/);
    assert.match(userSource, /WHERE id = \? AND password = \? AND token_version = \?/);
    assert.match(userSource, /upgradeResult\.meta\.changes !== 1/);
    assert.doesNotMatch(userSource, /Math\.random\(\)/);
    assert.match(adminSource, /hashUserPassword\(password\)/);
    assert.match(
        schema,
        /CREATE TABLE IF NOT EXISTS registration_challenges[\s\S]*?attempts INTEGER NOT NULL DEFAULT 0/,
    );
});

test('address passwords are also server-hardened and legacy values migrate on login', () => {
    const addressAuthSource = readFileSync(
        new URL('../src/mails_api/address_auth.ts', import.meta.url),
        'utf8',
    );
    const adminAddressSource = readFileSync(
        new URL('../src/admin_api/address_api.ts', import.meta.url),
        'utf8',
    );
    const commonSource = readFileSync(new URL('../src/common.ts', import.meta.url), 'utf8');

    assert.match(addressAuthSource, /hashUserPassword\(new_password\)/);
    assert.match(addressAuthSource, /verifyUserPassword\(address\.password, password\)/);
    assert.match(
        addressAuthSource,
        /WHERE id = \? AND password = \? AND token_version = \?/,
    );
    assert.match(addressAuthSource, /upgradeResult\.meta\.changes !== 1/);
    assert.match(adminAddressSource, /hashUserPassword\(password\)/);
    assert.match(commonSource, /hashUserPassword\(clientPasswordHash\)/);
});
