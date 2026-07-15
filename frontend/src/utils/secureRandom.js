export function secureRandomToken(byteLength = 32, cryptoApi = globalThis.crypto) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 1024) {
        throw new RangeError('byteLength must be an integer between 16 and 1024');
    }
    if (typeof cryptoApi?.getRandomValues !== 'function') {
        throw new Error('Secure random generation is unavailable');
    }

    const bytes = cryptoApi.getRandomValues(new Uint8Array(byteLength));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
