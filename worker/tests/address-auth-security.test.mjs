import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ADDRESS_TOKEN_TTL_SECONDS,
    buildAddressTokenPayload,
    buildUserRoleTokenPayload,
    isAddressTokenPayloadCurrent,
    isUserRoleTokenPayloadCurrent,
    loadAddressAuthRecord,
    loadBoundAddressOwner,
    loadCurrentUserRole,
    rotateAddressPassword,
    resetAddressPassword,
    validateAddressTokenAgainstDb,
    validateRoleTokenForAddress,
    validateRoleTokenForUser,
} from '../src/auth_tokens.ts';

const NOW = 1_750_000_000;
const ADDRESS = {
    id: 42,
    name: 'owner@example.com',
    token_version: 3,
};
const ROLE_OWNER = {
    user_id: 7,
    user_email: 'user@example.com',
    token_version: 3,
    role_text: 'premium',
};

test('new address token carries bounded lifetime and revocation claims', () => {
    const payload = buildAddressTokenPayload(ADDRESS, NOW);

    assert.deepEqual(payload, {
        typ: 'address',
        sub: '42',
        address: 'owner@example.com',
        address_id: 42,
        token_version: 3,
        iat: NOW,
        exp: NOW + ADDRESS_TOKEN_TTL_SECONDS,
    });
});

test('current address token must match id, name, subject, version and expiry', () => {
    const payload = buildAddressTokenPayload(ADDRESS, NOW);

    assert.equal(isAddressTokenPayloadCurrent(payload, ADDRESS, NOW), true);
    assert.equal(isAddressTokenPayloadCurrent({ ...payload, address_id: 43 }, ADDRESS, NOW), false);
    assert.equal(isAddressTokenPayloadCurrent({ ...payload, address: 'other@example.com' }, ADDRESS, NOW), false);
    assert.equal(isAddressTokenPayloadCurrent({ ...payload, sub: '43' }, ADDRESS, NOW), false);
    assert.equal(isAddressTokenPayloadCurrent({ ...payload, token_version: 2 }, ADDRESS, NOW), false);
    assert.equal(isAddressTokenPayloadCurrent({ ...payload, typ: 'user_role' }, ADDRESS, NOW), false);
    assert.equal(isAddressTokenPayloadCurrent({ ...payload, exp: NOW }, ADDRESS, NOW), false);
});

test('legacy address token remains usable only for the exact original version-zero row', () => {
    const legacyPayload = {
        address: 'owner@example.com',
        address_id: 42,
    };

    assert.equal(
        isAddressTokenPayloadCurrent(legacyPayload, { ...ADDRESS, token_version: 0 }, NOW),
        true,
    );
    assert.equal(isAddressTokenPayloadCurrent(legacyPayload, ADDRESS, NOW), false);
    assert.equal(
        isAddressTokenPayloadCurrent(
            legacyPayload,
            { id: 43, name: ADDRESS.name, token_version: 0 },
            NOW,
        ),
        false,
    );
    assert.equal(
        isAddressTokenPayloadCurrent(
            { ...legacyPayload, address_id: '42' },
            { ...ADDRESS, token_version: 0 },
            NOW,
        ),
        true,
    );
});

test('role token is rejected when borrowed by another user or address owner', () => {
    const payload = {
        typ: 'user_role',
        user_id: 7,
        user_email: 'user@example.com',
        token_version: 3,
        user_role: 'premium',
        iat: NOW - 10,
        exp: NOW + 100,
    };

    assert.equal(isUserRoleTokenPayloadCurrent(payload, ROLE_OWNER, NOW), true);
    assert.equal(isUserRoleTokenPayloadCurrent(payload, { ...ROLE_OWNER, user_id: 8 }, NOW), false);
    assert.equal(isUserRoleTokenPayloadCurrent(payload, { ...ROLE_OWNER, role_text: 'basic' }, NOW), false);
    assert.equal(isUserRoleTokenPayloadCurrent(payload, { ...ROLE_OWNER, token_version: 4 }, NOW), false);
    assert.equal(isUserRoleTokenPayloadCurrent({ ...payload, typ: 'address' }, ROLE_OWNER, NOW), false);
    assert.equal(isUserRoleTokenPayloadCurrent({ ...payload, exp: NOW }, ROLE_OWNER, NOW), false);
});

test('new role token is explicitly typed and remains short lived', () => {
    assert.deepEqual(buildUserRoleTokenPayload({
        user_email: 'user@example.com',
        user_id: 7,
        token_version: 3,
        user_role: 'premium',
    }, NOW), {
        typ: 'user_role',
        user_email: 'user@example.com',
        user_id: 7,
        token_version: 3,
        user_role: 'premium',
        iat: NOW,
        exp: NOW + 3600,
    });
});

test('legacy role token is accepted only with matching current database user and role', () => {
    const legacyPayload = {
        user_id: 7,
        user_email: 'user@example.com',
        user_role: 'premium',
        exp: NOW + 100,
    };

    assert.equal(
        isUserRoleTokenPayloadCurrent(legacyPayload, { ...ROLE_OWNER, token_version: 0 }, NOW),
        true,
    );
    assert.equal(isUserRoleTokenPayloadCurrent(legacyPayload, ROLE_OWNER, NOW), false);
});

const createFirstOnlyDb = (resolver) => ({
    prepare(sql) {
        return {
            bind(...values) {
                return {
                    first: () => resolver(sql, values),
                };
            },
        };
    },
});

test('address lookup is keyed by immutable address id and returns its revocation version', async () => {
    const calls = [];
    const db = createFirstOnlyDb((sql, values) => {
        calls.push({ sql, values });
        return { id: 42, name: ADDRESS.name, token_version: 3 };
    });

    assert.deepEqual(await loadAddressAuthRecord(db, 42), ADDRESS);
    assert.match(calls[0].sql, /WHERE id = \?/i);
    assert.deepEqual(calls[0].values, [42]);
});

test('address lookup has a narrow pre-migration fallback without weakening id binding', async () => {
    const calls = [];
    const db = createFirstOnlyDb((sql, values) => {
        calls.push({ sql, values });
        if (calls.length === 1) throw new Error('D1_ERROR: no such column: token_version');
        return { id: 42, name: ADDRESS.name };
    });

    assert.deepEqual(await loadAddressAuthRecord(db, 42), {
        id: 42,
        name: ADDRESS.name,
        token_version: 0,
    });
    assert.equal(calls.length, 2);
    assert.match(calls[1].sql, /WHERE id = \?/i);
    assert.deepEqual(calls[1].values, [42]);
});

test('role lookup binds privileges to the current address owner', async () => {
    const db = createFirstOnlyDb((sql, values) => {
        assert.match(sql, /users_address/i);
        assert.deepEqual(values, [42]);
        return ROLE_OWNER;
    });

    assert.deepEqual(await loadBoundAddressOwner(db, 42), ROLE_OWNER);
});

test('role lookup checks the current database role for the expected user', async () => {
    const db = createFirstOnlyDb((sql, values) => {
        assert.match(sql, /user_roles/i);
        assert.deepEqual(values, [7]);
        return { ...ROLE_OWNER, role_text: 'basic' };
    });

    assert.deepEqual(await loadCurrentUserRole(db, 7), {
        ...ROLE_OWNER,
        role_text: 'basic',
    });
});

test('password change atomically rotates version only for the authenticated row version', async () => {
    const db = createFirstOnlyDb((sql, values) => {
        assert.match(sql, /token_version\s*=\s*token_version\s*\+\s*1/i);
        assert.match(sql, /WHERE id = \? AND name = \? AND token_version = \?/i);
        assert.deepEqual(values, ['new-password-hash', 42, ADDRESS.name, 3]);
        return { id: 42, name: ADDRESS.name, token_version: 4 };
    });

    assert.deepEqual(
        await rotateAddressPassword(db, ADDRESS, 'new-password-hash'),
        { ...ADDRESS, token_version: 4 },
    );
});

test('admin password reset also rotates the credential version', async () => {
    const db = createFirstOnlyDb((sql, values) => {
        assert.match(sql, /token_version\s*=\s*token_version\s*\+\s*1/i);
        assert.match(sql, /WHERE id = \?/i);
        assert.deepEqual(values, ['admin-password-hash', 42]);
        return { id: 42, name: ADDRESS.name, token_version: 4 };
    });

    assert.deepEqual(
        await resetAddressPassword(db, 42, 'admin-password-hash'),
        { ...ADDRESS, token_version: 4 },
    );
});

test('database validation rejects a legacy token after same-name address recreation', async () => {
    const db = createFirstOnlyDb(() => ({
        id: 43,
        name: ADDRESS.name,
        token_version: 0,
    }));
    const legacyPayload = {
        address: ADDRESS.name,
        address_id: 42,
    };

    assert.equal(await validateAddressTokenAgainstDb(db, legacyPayload, NOW), null);
});

test('address role validation rejects a valid role token owned by another account', async () => {
    const db = createFirstOnlyDb(() => ROLE_OWNER);
    const borrowedPayload = {
        typ: 'user_role',
        user_id: 8,
        user_email: 'other@example.com',
        token_version: 3,
        user_role: 'premium',
        exp: NOW + 100,
    };

    assert.equal(await validateRoleTokenForAddress(db, borrowedPayload, 42, NOW), null);
});

test('user role validation rejects role claims after the database role changes', async () => {
    const db = createFirstOnlyDb(() => ({ ...ROLE_OWNER, role_text: 'basic' }));
    const stalePayload = {
        typ: 'user_role',
        user_id: 7,
        user_email: 'user@example.com',
        token_version: 3,
        user_role: 'premium',
        exp: NOW + 100,
    };

    assert.equal(await validateRoleTokenForUser(db, stalePayload, 7, NOW), null);
});

test('password reset revokes previously issued role tokens even when the role is unchanged', async () => {
    const db = createFirstOnlyDb(() => ({ ...ROLE_OWNER, token_version: 4 }));
    const stalePayload = buildUserRoleTokenPayload({
        user_email: ROLE_OWNER.user_email,
        user_id: ROLE_OWNER.user_id,
        token_version: 3,
        user_role: ROLE_OWNER.role_text,
    }, NOW - 10);

    assert.equal(await validateRoleTokenForUser(db, stalePayload, 7, NOW), null);
});
