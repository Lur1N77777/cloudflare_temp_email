import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('both password login endpoints pass through abuse controls', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const limiterBlock = source.match(
        /\/\/ rate limit for specific endpoints([\s\S]*?)const reqIp/,
    )?.[1] || '';
    assert.match(limiterBlock, /c\.req\.path\.startsWith\("\/api\/address_login"\)/);
    assert.match(limiterBlock, /c\.req\.path\.startsWith\("\/user_api\/login"\)/);
});
