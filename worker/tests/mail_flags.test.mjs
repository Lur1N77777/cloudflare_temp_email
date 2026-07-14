import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    flagColumns,
    normalizeFlags,
    normalizeMailbox,
} from '../src/mails_api/mail_flag_values.ts';

test('IMAP flags and mailbox names use strict allowlists', () => {
    assert.deepEqual(normalizeFlags(['\\Seen', '\\Flagged', '\\Seen']), ['\\Seen', '\\Flagged']);
    assert.throws(() => normalizeFlags(['\\Recent']));
    assert.throws(() => normalizeFlags(['\\Seen', 'custom']));
    assert.equal(normalizeMailbox('inbox'), 'INBOX');
    assert.equal(normalizeMailbox('sent'), 'SENT');
    assert.throws(() => normalizeMailbox('../INBOX'));
    assert.equal(flagColumns['\\Seen'], 'seen');
});

test('mail flag API is authenticated, batched and backed by D1', () => {
    const routes = readFileSync(new URL('../src/mails_api/index.ts', import.meta.url), 'utf8');
    const handler = readFileSync(new URL('../src/mails_api/mail_flags.ts', import.meta.url), 'utf8');
    const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    const mailCrud = readFileSync(new URL('../src/mails_api/mails_crud.ts', import.meta.url), 'utf8');
    const sendMailApi = readFileSync(
        new URL('../src/mails_api/send_mail_api.ts', import.meta.url),
        'utf8',
    );
    const adminAddressApi = readFileSync(
        new URL('../src/admin_api/address_api.ts', import.meta.url),
        'utf8',
    );
    const adminSendboxApi = readFileSync(
        new URL('../src/admin_api/sendbox_api.ts', import.meta.url),
        'utf8',
    );
    const adminMailApi = readFileSync(
        new URL('../src/admin_api/admin_mail_api.ts', import.meta.url),
        'utf8',
    );
    const userMailApi = readFileSync(
        new URL('../src/user_api/user_mail_api.ts', import.meta.url),
        'utf8',
    );
    const common = readFileSync(new URL('../src/common.ts', import.meta.url), 'utf8');
    const proxyClient = readFileSync(
        new URL('../../smtp_proxy_server/imap_http_client.py', import.meta.url),
        'utf8',
    );
    const proxyMailbox = readFileSync(
        new URL('../../smtp_proxy_server/imap_mailbox.py', import.meta.url),
        'utf8',
    );

    assert.match(routes, /api\.get\('\/api\/mail_flags'/);
    assert.match(routes, /api\.patch\('\/api\/mail_flags'/);
    assert.match(handler, /MAX_FLAG_QUERY_IDS/);
    assert.match(handler, /MAX_FLAG_UPDATES/);
    assert.match(handler, /INSERT INTO mail_flags/);
    assert.match(handler, /FROM raw_mails WHERE id = \? AND address = \?/);
    assert.match(handler, /sendbox/);
    assert.match(schema, /PRIMARY KEY \(address_id, mailbox, mail_id\)/);
    assert.match(mailCrud, /mailbox = 'INBOX'/);
    assert.match(mailCrud, /DELETE FROM mail_flags WHERE address_id = \? AND mailbox = 'SENT'/);
    assert.match(sendMailApi, /DELETE FROM mail_flags WHERE address_id = \? AND mailbox = 'SENT'/);
    assert.match(adminAddressApi, /DELETE FROM mail_flags WHERE address_id = \? AND mailbox = 'SENT'/);
    assert.match(adminSendboxApi, /mailbox = 'SENT'/);
    assert.match(adminMailApi, /mailbox = 'INBOX'/);
    assert.match(userMailApi, /mailbox = 'INBOX'/);
    assert.match(common, /case "sendbox"[\s\S]*mailbox = 'SENT'/);
    assert.match(proxyClient, /\/api\/mail_flags/);
    assert.match(proxyMailbox, /get_flags/);
    assert.match(proxyMailbox, /patch_flags/);
});
