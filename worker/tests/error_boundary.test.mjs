import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('global errors are correlated internally without exposing implementation details', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const handler = source.match(/app\.onError\(\(err, c\) => \{([\s\S]*?)\n\}\)/)?.[1] || '';

    assert.match(handler, /requestId/);
    assert.match(handler, /crypto\.randomUUID\(\)/);
    assert.match(handler, /Internal server error/);
    assert.doesNotMatch(handler, /c\.text\(`\$\{err\.name\}/);
});
