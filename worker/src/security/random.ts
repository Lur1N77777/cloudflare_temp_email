const UINT32_RANGE = 0x1_0000_0000;
const LOWERCASE_ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

export function secureRandomIndex(upperBound: number): number {
    if (!Number.isSafeInteger(upperBound) || upperBound < 1 || upperBound > UINT32_RANGE) {
        throw new RangeError("upperBound must be an integer between 1 and 2^32");
    }

    const unbiasedLimit = Math.floor(UINT32_RANGE / upperBound) * upperBound;
    const values = new Uint32Array(1);
    do {
        crypto.getRandomValues(values);
    } while (values[0] >= unbiasedLimit);
    return values[0] % upperBound;
}

export function secureRandomString(length: number, charset: string): string {
    if (!Number.isSafeInteger(length) || length < 0) {
        throw new RangeError("length must be a non-negative integer");
    }
    if (!charset) {
        throw new RangeError("charset must not be empty");
    }

    let value = "";
    for (let index = 0; index < length; index += 1) {
        value += charset.charAt(secureRandomIndex(charset.length));
    }
    return value;
}

export function generateRandomPassword(): string {
    return secureRandomString(8, LOWERCASE_ALPHANUMERIC);
}
