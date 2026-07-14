import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
    SEND_BALANCE_RELEASE_SQL,
    SEND_BALANCE_RESERVE_SQL,
    SEND_MAIL_QUOTA_RELEASE_SQL,
    SEND_MAIL_QUOTA_RESERVE_SQL,
} from '../src/mails_api/send_reservation_sql.ts';
import {
    buildInboundDeliveryKey,
    temporaryDeliveryFailure,
} from '../src/email/delivery_failure.ts';

test('a sender balance can be reserved once and never becomes negative', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE address_sender (
            address TEXT PRIMARY KEY,
            balance INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1
        );
        INSERT INTO address_sender (address, balance, enabled)
        VALUES ('sender@example.com', 1, 1);
    `);
    const reserve = db.prepare(SEND_BALANCE_RESERVE_SQL);
    assert.equal(reserve.run('sender@example.com').changes, 1);
    assert.equal(reserve.run('sender@example.com').changes, 0);
    assert.equal(
        db.prepare('SELECT balance FROM address_sender WHERE address = ?')
            .get('sender@example.com').balance,
        0,
    );
    assert.equal(db.prepare(SEND_BALANCE_RELEASE_SQL).run('sender@example.com').changes, 1);
    assert.equal(
        db.prepare('SELECT balance FROM address_sender WHERE address = ?')
            .get('sender@example.com').balance,
        1,
    );
});

test('daily and monthly quota are reserved in one all-or-nothing statement', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE send_mail_quota_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            daily_period TEXT NOT NULL,
            daily_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_count >= 0),
            monthly_period TEXT NOT NULL,
            monthly_count INTEGER NOT NULL DEFAULT 0 CHECK (monthly_count >= 0),
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const reserve = db.prepare(SEND_MAIL_QUOTA_RESERVE_SQL);
    const bindings = [
        '2026-07-13', 1, '2026-07', 1,
        1, 1, 1, 10,
        1, 1,
        1, 1, 1, 10,
    ];
    assert.equal(reserve.run(...bindings).changes, 1);
    assert.equal(reserve.run(...bindings).changes, 0);
    let state = db.prepare(
        'SELECT daily_count, monthly_count FROM send_mail_quota_state',
    ).get();
    assert.equal(state.daily_count, 1);
    assert.equal(state.monthly_count, 1);
    assert.equal(
        db.prepare(SEND_MAIL_QUOTA_RELEASE_SQL)
            .run(
                '2026-07-13', 1, '2026-07', 1,
                '2026-07-13', 1, '2026-07', 1,
            ).changes,
        1,
    );
    state = db.prepare(
        'SELECT daily_count, monthly_count FROM send_mail_quota_state',
    ).get();
    assert.equal(state.daily_count, 0);
    assert.equal(state.monthly_count, 0);
});

test('quota zero rejects even when the singleton row does not exist yet', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE send_mail_quota_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            daily_period TEXT NOT NULL,
            daily_count INTEGER NOT NULL DEFAULT 0 CHECK (daily_count >= 0),
            monthly_period TEXT NOT NULL,
            monthly_count INTEGER NOT NULL DEFAULT 0 CHECK (monthly_count >= 0),
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    const bindings = [
        '2026-07-13', 1, '2026-07', 0,
        1, 0, 0, -1,
        1, 0,
        1, 0, 0, -1,
    ];
    assert.equal(db.prepare(SEND_MAIL_QUOTA_RESERVE_SQL).run(...bindings).changes, 0);
});

test('storage failures surface as temporary errors before downstream side effects', () => {
    assert.throws(
        () => temporaryDeliveryFailure('mail@example.com', new Error('D1 unavailable')),
        /Temporary inbound storage failure/,
    );

    const source = readFileSync(new URL('../src/email/index.ts', import.meta.url), 'utf8');
    assert.match(source, /catch \(error\) \{[\s\S]*temporaryDeliveryFailure\([\s\S]*\}\s*\/\/ forward email/);
    assert.doesNotMatch(source, /setReject\(`Temporary storage failure/);
});

test('inbound retries have a unique delivery constraint and isolated side effects', async () => {
    const source = readFileSync(new URL('../src/email/index.ts', import.meta.url), 'utf8');
    const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');

    const first = await buildInboundDeliveryKey('to@example.com', 'from@example.net', '<id@example.net>');
    const retry = await buildInboundDeliveryKey('TO@example.com', 'FROM@example.net', ' <id@example.net> ');
    assert.equal(first, retry);
    assert.match(first, /^v1:[a-f0-9]{64}$/);
    assert.equal(
        await buildInboundDeliveryKey('to@example.com', 'from@example.net', null),
        null,
    );
    assert.match(schema, /delivery_key TEXT/);
    assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_mails_delivery_key[\s\S]*WHERE delivery_key IS NOT NULL/);
    assert.match(
        source,
        /ON CONFLICT\(delivery_key\) WHERE delivery_key IS NOT NULL DO NOTHING/,
    );
    assert.match(source, /if \(isDuplicate\) \{[\s\S]*return;/);
    assert.match(source, /try \{[\s\S]*await forwardEmail\(/);
    assert.match(source, /try \{[\s\S]*await auto_reply\(/);
    assert.match(source, /try \{[\s\S]*await extractEmailInfo\(/);
});

test('the inbound delivery migration preserves legacy rows and atomically deduplicates new keys', () => {
    const migration = readFileSync(
        new URL('../../db/2026-07-13-inbound-delivery-index.sql', import.meta.url),
        'utf8',
    );
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE raw_mails (
            id INTEGER PRIMARY KEY,
            message_id TEXT,
            source TEXT,
            address TEXT,
            raw TEXT
        );
        INSERT INTO raw_mails (message_id, source, address, raw)
        VALUES
            ('<legacy@example.net>', 'from@example.net', 'to@example.com', 'first'),
            ('<legacy@example.net>', 'from@example.net', 'to@example.com', 'retry');
    `);

    db.exec(migration);

    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM raw_mails').get().count,
        2,
    );
    assert.ok(
        db.prepare('PRAGMA table_info(raw_mails)').all()
            .some((column) => column.name === 'delivery_key'),
    );

    const insert = db.prepare(`
        INSERT INTO raw_mails (message_id, source, address, raw, delivery_key)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(delivery_key) WHERE delivery_key IS NOT NULL DO NOTHING
    `);
    assert.equal(
        insert.run('<new@example.net>', 'from@example.net', 'to@example.com', 'new', 'v1:key').changes,
        1,
    );
    assert.equal(
        insert.run('<new@example.net>', 'from@example.net', 'to@example.com', 'retry', 'v1:key').changes,
        0,
    );
    assert.equal(
        insert.run(null, 'from@example.net', 'to@example.com', 'without id 1', null).changes,
        1,
    );
    assert.equal(
        insert.run(null, 'from@example.net', 'to@example.com', 'without id 2', null).changes,
        1,
    );
});
