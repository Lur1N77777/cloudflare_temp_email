const PASSWORD_HASH_ALGORITHM = 'PBKDF2';
const PASSWORD_HASH_DIGEST = 'SHA-256';
const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256';
const PASSWORD_HASH_VERSION = 1;
const PASSWORD_HASH_ITERATIONS = 310_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;

const encodeBase64 = (value: Uint8Array): string => {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
};

const decodeBase64 = (value: string): Uint8Array => {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const derivePassword = async (
    suppliedPassword: string,
    salt: Uint8Array,
    iterations: number,
): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(suppliedPassword),
        PASSWORD_HASH_ALGORITHM,
        false,
        ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits({
        name: PASSWORD_HASH_ALGORITHM,
        hash: PASSWORD_HASH_DIGEST,
        salt,
        iterations,
    }, key, PASSWORD_HASH_BYTES * 8);
    return new Uint8Array(bits);
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
    let difference = left.length ^ right.length;
    const maxLength = Math.max(left.length, right.length);
    for (let index = 0; index < maxLength; index += 1) {
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
    }
    return difference === 0;
};

const constantTimeStringEqual = (left: string, right: string): boolean => {
    return constantTimeEqual(
        new TextEncoder().encode(left),
        new TextEncoder().encode(right),
    );
};

type ParsedPasswordHash = {
    iterations: number;
    salt: Uint8Array;
    digest: Uint8Array;
};

const parsePasswordHash = (storedPassword: string): ParsedPasswordHash | null => {
    const [prefix, versionText, iterationsText, saltText, digestText, extra] = storedPassword.split('$');
    if (extra !== undefined
        || prefix !== PASSWORD_HASH_PREFIX
        || versionText !== `v=${PASSWORD_HASH_VERSION}`
        || !/^i=\d+$/.test(iterationsText || '')
        || !saltText
        || !digestText
    ) return null;
    const iterations = Number(iterationsText.slice(2));
    if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return null;
    try {
        const salt = decodeBase64(saltText);
        const digest = decodeBase64(digestText);
        if (salt.length < 16 || digest.length !== PASSWORD_HASH_BYTES) return null;
        return { iterations, salt, digest };
    } catch {
        return null;
    }
};

export const isPasswordHash = (storedPassword: string): boolean => {
    return parsePasswordHash(storedPassword) !== null;
};

export const hashUserPassword = async (suppliedPassword: string): Promise<string> => {
    const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
    const digest = await derivePassword(suppliedPassword, salt, PASSWORD_HASH_ITERATIONS);
    return [
        PASSWORD_HASH_PREFIX,
        `v=${PASSWORD_HASH_VERSION}`,
        `i=${PASSWORD_HASH_ITERATIONS}`,
        encodeBase64(salt),
        encodeBase64(digest),
    ].join('$');
};

export const verifyUserPassword = async (
    storedPassword: string,
    suppliedPassword: string,
): Promise<{ valid: boolean; needsUpgrade: boolean }> => {
    const parsed = parsePasswordHash(storedPassword);
    if (!parsed) {
        if (storedPassword.startsWith(`${PASSWORD_HASH_PREFIX}$`)) {
            return { valid: false, needsUpgrade: false };
        }
        const valid = constantTimeStringEqual(storedPassword, suppliedPassword);
        return { valid, needsUpgrade: valid };
    }
    const suppliedDigest = await derivePassword(
        suppliedPassword,
        parsed.salt,
        parsed.iterations,
    );
    const valid = constantTimeEqual(parsed.digest, suppliedDigest);
    return {
        valid,
        needsUpgrade: valid && parsed.iterations < PASSWORD_HASH_ITERATIONS,
    };
};
