import { describe, expect, it } from 'vitest';

import { secureRandomToken } from '../secureRandom';

describe('secureRandomToken', () => {
    it('uses WebCrypto bytes and returns a fixed-length hexadecimal token', () => {
        let calls = 0;
        const cryptoApi = {
            getRandomValues(bytes) {
                calls += 1;
                bytes.forEach((_value, index) => {
                    bytes[index] = index;
                });
                return bytes;
            },
        };

        const token = secureRandomToken(16, cryptoApi);
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(calls).toBe(1);
    });

    it('fails closed when secure randomness is unavailable', () => {
        expect(() => secureRandomToken(16, {})).toThrow(/Secure random generation is unavailable/);
    });
});
