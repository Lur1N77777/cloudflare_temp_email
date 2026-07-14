import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('address mail IDs have a lightweight stable cursor endpoint', () => {
    const source = readFileSync(new URL('../src/mails_api/mails_crud.ts', import.meta.url), 'utf8');
    const routes = readFileSync(new URL('../src/mails_api/index.ts', import.meta.url), 'utf8');
    const proxyClient = readFileSync(
        new URL('../../smtp_proxy_server/imap_http_client.py', import.meta.url),
        'utf8',
    );
    const mailbox = readFileSync(
        new URL('../../smtp_proxy_server/imap_mailbox.py', import.meta.url),
        'utf8',
    );

    assert.match(routes, /api\.get\('\/api\/mail_ids'/);
    assert.match(routes, /api\.get\('\/api\/mail_details'/);
    assert.match(source, /SELECT id, message_id, source, address, metadata, created_at/);
    assert.match(source, /id < \?/);
    assert.match(source, /mailbox === 'SENT'/);
    assert.match(source, /FROM sendbox/);
    assert.match(source, /next_cursor/);
    const lightweightQuery = source.match(
        /SELECT id, message_id, source, address, metadata, created_at[\s\S]*?\.all/,
    )?.[0] || '';
    assert.doesNotMatch(lightweightQuery, /raw_blob|\braw\b/);
    assert.match(proxyClient, /\/api\/mail_ids/);
    assert.match(proxyClient, /\/api\/mail_details/);
    assert.match(mailbox, /get_mail_ids/);
    assert.match(mailbox, /get_mail_details/);
    assert.doesNotMatch(mailbox, /while offset < (?:count|total)/);
});
