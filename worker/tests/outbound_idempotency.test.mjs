import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
    OUTBOUND_REQUEST_CLAIM_SQL,
    OUTBOUND_REQUEST_COMPLETE_SQL,
    OUTBOUND_REQUEST_FAIL_SQL,
    beginOutboundSendRequest,
    canonicalPayloadHash,
    completeOutboundSendRequest,
    failOutboundSendRequest,
    normalizeIdempotencyKey,
    resolveOutboundIdempotencyKey,
} from '../src/mails_api/outbound_idempotency.ts';

const createD1Adapter = (db) => ({
    prepare(sql) {
        const statement = db.prepare(sql);
        let values = [];
        return {
            bind(...nextValues) {
                values = nextValues;
                return this;
            },
            async run() {
                const result = statement.run(...values);
                return { success: true, meta: { changes: result.changes } };
            },
            async first() {
                return statement.get(...values);
            },
        };
    },
});

test('outbound idempotency keys are bounded and payload hashes ignore object key order', async () => {
    assert.equal(normalizeIdempotencyKey('  retry-123  '), 'retry-123');
    assert.throws(() => normalizeIdempotencyKey('contains whitespace'));
    assert.throws(() => normalizeIdempotencyKey('unicode-邮件'));
    assert.throws(() => normalizeIdempotencyKey('x'.repeat(129)));
    assert.equal(resolveOutboundIdempotencyKey('retry-123'), 'retry-123');
    assert.equal(resolveOutboundIdempotencyKey(undefined, 'retry-123'), 'retry-123');
    assert.throws(() => resolveOutboundIdempotencyKey('retry-123', 'different-key'));
    assert.match(resolveOutboundIdempotencyKey(undefined), /^auto-[0-9a-f-]{36}$/);
    assert.equal(
        await canonicalPayloadHash({ to: 'a@example.com', subject: 'hello' }),
        await canonicalPayloadHash({ subject: 'hello', to: 'a@example.com' }),
    );
    assert.equal(
        await canonicalPayloadHash({ headers: { z: 'last', a: 'first' }, to: ['a', 'b'] }),
        await canonicalPayloadHash({ to: ['a', 'b'], headers: { a: 'first', z: 'last' } }),
    );
});

test('only one concurrent-equivalent outbound request can claim a key', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE outbound_send_requests (
            address TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            completed_at INTEGER,
            PRIMARY KEY (address, idempotency_key)
        )
    `);
    const claim = db.prepare(OUTBOUND_REQUEST_CLAIM_SQL);
    assert.equal(claim.run('sender@example.com', 'retry-123', 'hash-a').changes, 1);
    assert.equal(claim.run('sender@example.com', 'retry-123', 'hash-a').changes, 0);
    assert.equal(claim.run('sender@example.com', 'retry-123', 'hash-b').changes, 0);
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM outbound_send_requests').get().count,
        1,
    );

    const complete = db.prepare(OUTBOUND_REQUEST_COMPLETE_SQL);
    const fail = db.prepare(OUTBOUND_REQUEST_FAIL_SQL);
    assert.equal(complete.run('sender@example.com', 'retry-123', 'hash-a').changes, 1);
    assert.equal(fail.run('sender@example.com', 'retry-123', 'hash-a').changes, 0);
    assert.equal(
        db.prepare('SELECT status FROM outbound_send_requests').get().status,
        'completed',
    );
});

test('ledger helpers distinguish pending, completed, failed, and conflicting retries', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
        CREATE TABLE outbound_send_requests (
            address TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            completed_at INTEGER,
            PRIMARY KEY (address, idempotency_key)
        )
    `);
    const db = createD1Adapter(sqlite);
    const payload = { subject: 'hello', to: 'recipient@example.com' };
    const claim = await beginOutboundSendRequest(
        db,
        'Sender@Example.com',
        'retry-123',
        payload,
    );
    assert.equal(claim.state, 'claimed');
    assert.equal(
        (await beginOutboundSendRequest(db, claim.address, claim.idempotencyKey, payload)).state,
        'pending',
    );
    assert.equal(
        (
            await beginOutboundSendRequest(
                db,
                claim.address,
                claim.idempotencyKey,
                { ...payload, subject: 'different' },
            )
        ).state,
        'conflict',
    );
    assert.equal(
        (
            await beginOutboundSendRequest(
                db,
                'other-sender@example.com',
                claim.idempotencyKey,
                payload,
            )
        ).state,
        'claimed',
    );
    await completeOutboundSendRequest(db, claim);
    assert.equal(
        (await beginOutboundSendRequest(db, claim.address, claim.idempotencyKey, payload)).state,
        'completed',
    );

    const failedClaim = await beginOutboundSendRequest(
        db,
        claim.address,
        'retry-failed',
        payload,
    );
    await failOutboundSendRequest(db, failedClaim);
    assert.equal(
        (
            await beginOutboundSendRequest(
                db,
                failedClaim.address,
                failedClaim.idempotencyKey,
                payload,
            )
        ).state,
        'failed',
    );
});

test('fresh databases and upgrades both create the outbound request ledger', () => {
    const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    const migration = readFileSync(
        new URL('../../db/2026-07-13-outbound-send-requests.sql', import.meta.url),
        'utf8',
    );
    const adminDbApi = readFileSync(
        new URL('../src/admin_api/db_api.ts', import.meta.url),
        'utf8',
    );
    for (const sql of [schema, migration, adminDbApi]) {
        assert.match(sql, /CREATE TABLE IF NOT EXISTS outbound_send_requests/);
        assert.match(sql, /PRIMARY KEY \(address, idempotency_key\)/);
        assert.match(sql, /idx_outbound_send_requests_updated_at/);
    }
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    db.exec(migration);
    db.exec(migration);
    assert.equal(
        db.prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'table' AND name = 'outbound_send_requests'`,
        ).get().count,
        1,
    );
});

test('every public outbound route uses the ledger and never returns provider details', () => {
    const sendApi = readFileSync(
        new URL('../src/mails_api/send_mail_api.ts', import.meta.url),
        'utf8',
    );
    const adminApi = readFileSync(
        new URL('../src/admin_api/send_mail.ts', import.meta.url),
        'utf8',
    );
    assert.match(sendApi, /beginOutboundSendRequest/);
    assert.match(sendApi, /completeOutboundSendRequest/);
    assert.match(sendApi, /failOutboundSendRequest/);
    assert.doesNotMatch(sendApi, /Failed to send mail \$\{\(e as Error\)\.message\}/);
    assert.match(adminApi, /beginOutboundSendRequest/);
    assert.match(adminApi, /completeOutboundSendRequest/);
    assert.match(adminApi, /failOutboundSendRequest/);
    assert.doesNotMatch(adminApi, /FailedToRegisterMsg}: \$\{errorMsg\}/);
});
