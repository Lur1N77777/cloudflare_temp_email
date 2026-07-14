export const ADDRESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
export const USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const USER_ROLE_TOKEN_TTL_SECONDS = 60 * 60;

export type AddressAuthRecord = {
    id: number;
    name: string;
    token_version: number;
};

export type UserRoleRecord = {
    user_id: number;
    user_email: string;
    token_version: number;
    role_text: string | null;
};

export type UserAuthRecord = {
    id: number;
    user_email: string;
    token_version: number;
};

type AddressTokenPayload = {
    typ: 'address';
    sub: string;
    address: string;
    address_id: number;
    token_version: number;
    iat: number;
    exp: number;
};

type UserRoleTokenPayload = {
    typ: 'user_role';
    user_email: string;
    user_id: number;
    token_version: number;
    user_role: string;
    iat: number;
    exp: number;
};

type UserTokenPayload = {
    typ: 'user';
    sub: string;
    user_email: string;
    user_id: number;
    token_version: number;
    iat: number;
    exp: number;
};

const isFiniteInteger = (value: unknown): value is number => (
    typeof value === 'number' && Number.isSafeInteger(value)
);

const toPositiveSafeInteger = (value: unknown): number | null => {
    if (isFiniteInteger(value) && value > 0) return value;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const normalizeAddressAuthRecord = (
    value: Record<string, unknown> | null,
): AddressAuthRecord | null => {
    if (!value || !isFiniteInteger(value.id) || value.id <= 0) return null;
    if (typeof value.name !== 'string' || !value.name) return null;
    const tokenVersion = value.token_version ?? 0;
    if (!isFiniteInteger(tokenVersion) || tokenVersion < 0) return null;
    return {
        id: value.id,
        name: value.name,
        token_version: tokenVersion,
    };
};

const normalizeUserRoleRecord = (
    value: Record<string, unknown> | null,
): UserRoleRecord | null => {
    if (!value || !isFiniteInteger(value.user_id) || value.user_id <= 0) return null;
    if (typeof value.user_email !== 'string' || !value.user_email) return null;
    const tokenVersion = value.token_version ?? 0;
    if (!isFiniteInteger(tokenVersion) || tokenVersion < 0) return null;
    if (value.role_text !== null && typeof value.role_text !== 'string') return null;
    return {
        user_id: value.user_id,
        user_email: value.user_email,
        token_version: tokenVersion,
        role_text: value.role_text as string | null,
    };
};

const normalizeUserAuthRecord = (
    value: Record<string, unknown> | null,
): UserAuthRecord | null => {
    if (!value || !isFiniteInteger(value.id) || value.id <= 0) return null;
    if (typeof value.user_email !== 'string' || !value.user_email) return null;
    const tokenVersion = value.token_version ?? 0;
    if (!isFiniteInteger(tokenVersion) || tokenVersion < 0) return null;
    return {
        id: value.id,
        user_email: value.user_email,
        token_version: tokenVersion,
    };
};

const isMissingTokenVersionColumn = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /no such column:\s*token_version/i.test(message);
};

export const buildAddressTokenPayload = (
    address: AddressAuthRecord,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): AddressTokenPayload => ({
    typ: 'address',
    sub: String(address.id),
    address: address.name,
    address_id: address.id,
    token_version: address.token_version,
    iat: nowSeconds,
    exp: nowSeconds + ADDRESS_TOKEN_TTL_SECONDS,
});

export const buildUserTokenPayload = (
    user: UserAuthRecord,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): UserTokenPayload => ({
    typ: 'user',
    sub: String(user.id),
    user_email: user.user_email,
    user_id: user.id,
    token_version: user.token_version,
    iat: nowSeconds,
    exp: nowSeconds + USER_TOKEN_TTL_SECONDS,
});

export const buildUserRoleTokenPayload = (
    user: Pick<
        UserRoleTokenPayload,
        'user_email' | 'user_id' | 'token_version' | 'user_role'
    >,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): UserRoleTokenPayload => ({
    typ: 'user_role',
    ...user,
    iat: nowSeconds,
    exp: nowSeconds + USER_ROLE_TOKEN_TTL_SECONDS,
});

export const isAddressTokenPayloadCurrent = (
    payload: Record<string, unknown>,
    address: AddressAuthRecord,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean => {
    const payloadAddressId = toPositiveSafeInteger(payload.address_id);
    if (payloadAddressId !== address.id || payload.address !== address.name) return false;

    const isLegacyToken = payload.typ === undefined
        && payload.sub === undefined
        && payload.token_version === undefined
        && payload.iat === undefined
        && payload.exp === undefined;
    if (isLegacyToken) {
        return address.token_version === 0;
    }

    if (payload.typ !== 'address' || payload.sub !== String(address.id)) return false;
    if (!isFiniteInteger(payload.token_version)) return false;
    if (payload.token_version !== address.token_version) return false;
    if (!isFiniteInteger(payload.iat) || !isFiniteInteger(payload.exp)) return false;
    return payload.exp > nowSeconds && payload.exp > payload.iat;
};

export const isUserTokenPayloadCurrent = (
    payload: Record<string, unknown>,
    user: UserAuthRecord,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean => {
    const payloadUserId = toPositiveSafeInteger(payload.user_id);
    if (payloadUserId !== user.id || payload.user_email !== user.user_email) return false;
    if (!isFiniteInteger(payload.iat) || !isFiniteInteger(payload.exp)) return false;
    if (payload.exp <= nowSeconds || payload.exp <= payload.iat) return false;

    const isLegacyToken = payload.typ === undefined
        && payload.sub === undefined
        && payload.token_version === undefined;
    if (isLegacyToken) return user.token_version === 0;

    return payload.typ === 'user'
        && payload.sub === String(user.id)
        && isFiniteInteger(payload.token_version)
        && payload.token_version === user.token_version;
};

export const isUserRoleTokenPayloadCurrent = (
    payload: Record<string, unknown>,
    user: UserRoleRecord,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean => {
    if (!isFiniteInteger(payload.user_id) || payload.user_id !== user.user_id) return false;
    if (payload.user_email !== user.user_email) return false;
    if (typeof payload.user_role !== 'string' || payload.user_role !== user.role_text) return false;
    if (!isFiniteInteger(payload.exp) || payload.exp <= nowSeconds) return false;

    const isLegacyToken = payload.typ === undefined
        && payload.token_version === undefined
        && payload.iat === undefined;
    if (isLegacyToken) return user.token_version === 0;

    return payload.typ === 'user_role'
        && isFiniteInteger(payload.token_version)
        && payload.token_version === user.token_version
        && isFiniteInteger(payload.iat)
        && payload.exp > payload.iat;
};

export const loadAddressAuthRecord = async (
    db: D1Database,
    addressId: number,
): Promise<AddressAuthRecord | null> => {
    if (!isFiniteInteger(addressId) || addressId <= 0) return null;
    try {
        const row = await db.prepare(
            `SELECT id, name, token_version FROM address WHERE id = ?`,
        ).bind(addressId).first<Record<string, unknown>>();
        return normalizeAddressAuthRecord(row);
    } catch (error) {
        if (!isMissingTokenVersionColumn(error)) throw error;
        const legacyRow = await db.prepare(
            `SELECT id, name FROM address WHERE id = ?`,
        ).bind(addressId).first<Record<string, unknown>>();
        return normalizeAddressAuthRecord(legacyRow);
    }
};

export const loadUserAuthRecord = async (
    db: D1Database,
    userId: number,
): Promise<UserAuthRecord | null> => {
    if (!isFiniteInteger(userId) || userId <= 0) return null;
    try {
        const row = await db.prepare(
            `SELECT id, user_email, token_version FROM users WHERE id = ?`,
        ).bind(userId).first<Record<string, unknown>>();
        return normalizeUserAuthRecord(row);
    } catch (error) {
        if (!isMissingTokenVersionColumn(error)) throw error;
        const legacyRow = await db.prepare(
            `SELECT id, user_email FROM users WHERE id = ?`,
        ).bind(userId).first<Record<string, unknown>>();
        return normalizeUserAuthRecord(legacyRow);
    }
};

export const loadBoundAddressOwner = async (
    db: D1Database,
    addressId: number,
): Promise<UserRoleRecord | null> => {
    if (!isFiniteInteger(addressId) || addressId <= 0) return null;
    const row = await db.prepare(
        `SELECT ua.user_id, u.user_email, u.token_version, ur.role_text
        FROM users_address ua
        JOIN users u ON u.id = ua.user_id
        LEFT JOIN user_roles ur ON ur.user_id = ua.user_id
        WHERE ua.address_id = ?`,
    ).bind(addressId).first<Record<string, unknown>>();
    return normalizeUserRoleRecord(row);
};

export const loadCurrentUserRole = async (
    db: D1Database,
    userId: number,
): Promise<UserRoleRecord | null> => {
    if (!isFiniteInteger(userId) || userId <= 0) return null;
    const row = await db.prepare(
        `SELECT u.id AS user_id, u.user_email, u.token_version, ur.role_text
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.id = ?`,
    ).bind(userId).first<Record<string, unknown>>();
    return normalizeUserRoleRecord(row);
};

export const rotateAddressPassword = async (
    db: D1Database,
    address: AddressAuthRecord,
    password: string,
): Promise<AddressAuthRecord | null> => {
    const row = await db.prepare(
        `UPDATE address
        SET password = ?, token_version = token_version + 1, updated_at = datetime('now')
        WHERE id = ? AND name = ? AND token_version = ?
        RETURNING id, name, token_version`,
    ).bind(password, address.id, address.name, address.token_version)
        .first<Record<string, unknown>>();
    return normalizeAddressAuthRecord(row);
};

export const resetAddressPassword = async (
    db: D1Database,
    addressId: number,
    password: string,
): Promise<AddressAuthRecord | null> => {
    if (!isFiniteInteger(addressId) || addressId <= 0) return null;
    const row = await db.prepare(
        `UPDATE address
        SET password = ?, token_version = token_version + 1, updated_at = datetime('now')
        WHERE id = ?
        RETURNING id, name, token_version`,
    ).bind(password, addressId).first<Record<string, unknown>>();
    return normalizeAddressAuthRecord(row);
};

export const validateAddressTokenAgainstDb = async (
    db: D1Database,
    payload: Record<string, unknown>,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AddressAuthRecord | null> => {
    const addressId = toPositiveSafeInteger(payload.address_id);
    if (!addressId) return null;
    const address = await loadAddressAuthRecord(db, addressId);
    if (!address || !isAddressTokenPayloadCurrent(payload, address, nowSeconds)) return null;
    return address;
};

export const validateUserTokenAgainstDb = async (
    db: D1Database,
    payload: Record<string, unknown>,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<UserAuthRecord | null> => {
    const userId = toPositiveSafeInteger(payload.user_id);
    if (!userId) return null;
    const user = await loadUserAuthRecord(db, userId);
    if (!user || !isUserTokenPayloadCurrent(payload, user, nowSeconds)) return null;
    return user;
};

export const validateRoleTokenForAddress = async (
    db: D1Database,
    payload: Record<string, unknown>,
    addressId: number,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> => {
    const owner = await loadBoundAddressOwner(db, addressId);
    if (!owner || !isUserRoleTokenPayloadCurrent(
        payload,
        owner,
        nowSeconds,
    )) return null;
    return owner.role_text;
};

export const validateRoleTokenForUser = async (
    db: D1Database,
    payload: Record<string, unknown>,
    userId: number,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> => {
    const user = await loadCurrentUserRole(db, userId);
    if (!user || !isUserRoleTokenPayloadCurrent(
        payload,
        user,
        nowSeconds,
    )) return null;
    return user.role_text;
};
