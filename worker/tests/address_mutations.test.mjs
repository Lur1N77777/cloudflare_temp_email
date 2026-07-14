import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('address deletion uses one D1 batch and removes every address-scoped record first', () => {
    const commonSource = readFileSync(new URL('../src/common.ts', import.meta.url), 'utf8');
    const adminSource = readFileSync(new URL('../src/admin_api/address_api.ts', import.meta.url), 'utf8');

    assert.match(commonSource, /deleteAddressWithData[\s\S]*c\.env\.DB\.batch\(/);
    for (const table of [
        'raw_mails', 'sendbox', 'auto_reply_mails', 'address_sender', 'users_address',
    ]) {
        assert.match(commonSource, new RegExp(`DELETE FROM ${table}`));
    }
    assert.match(adminSource, /deleteAddressWithData\(c, null, Number\(id\)/);
    assert.doesNotMatch(adminSource, /DELETE FROM address WHERE id/);
});

test('address transfer changes ownership and rotates credentials in one D1 batch', () => {
    const source = readFileSync(new URL('../src/user_api/bind_address.ts', import.meta.url), 'utf8');

    assert.match(source, /transferAddress[\s\S]*c\.env\.DB\.batch\(/);
    assert.match(source, /UPDATE users_address SET user_id = \?/);
    assert.match(source, /token_version = token_version \+ 1/);
    assert.match(source, /password = NULL/);
    assert.doesNotMatch(source, /DELETE FROM address WHERE id/);
});

test('logged-in address creation inserts and binds in the same D1 batch', () => {
    const commonSource = readFileSync(new URL('../src/common.ts', import.meta.url), 'utf8');
    const routeSource = readFileSync(
        new URL('../src/mails_api/new_address.ts', import.meta.url),
        'utf8',
    );

    assert.match(routeSource, /bindUserId:\s*userPayload\?\.user_id/);
    assert.match(commonSource, /INSERT INTO users_address \(user_id, address_id\)/);
    assert.match(commonSource, /insertAddressRecord[\s\S]*c\.env\.DB\.batch\(/);
});
