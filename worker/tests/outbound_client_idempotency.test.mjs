import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createOutboundIdempotencyTracker } from '../../frontend/src/utils/outboundIdempotency.js';

test('worker UI outbound attempts use RFC 4122 UUIDs by default', () => {
    const tracker = createOutboundIdempotencyTracker();
    assert.match(
        tracker.begin('/api/send_mail', { subject: 'hello' }).key,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
});

test('worker UI retries reuse a key only for the same draft after network or 5xx errors', () => {
    let nextKey = 0;
    const tracker = createOutboundIdempotencyTracker(() => `worker-key-${++nextKey}`);
    const payload = {
        to_mail: 'to@example.com',
        subject: 'hello',
        content: 'body',
    };

    const first = tracker.begin('/api/send_mail', payload);
    tracker.failed(first, new TypeError('Failed to fetch'));
    assert.equal(tracker.begin('/api/send_mail', { ...payload }).key, first.key);

    tracker.failed(first, new Error('[503]: temporary outage'));
    assert.equal(tracker.begin('/api/send_mail', { ...payload }).key, first.key);

    const edited = tracker.begin('/api/send_mail', { ...payload, content: 'edited body' });
    assert.notEqual(edited.key, first.key);
});

test('worker UI keys rotate after success or a definitive 4xx response', () => {
    let nextKey = 0;
    const tracker = createOutboundIdempotencyTracker(() => `worker-key-${++nextKey}`);
    const payload = {
        to_mail: 'to@example.com',
        subject: 'hello',
        content: 'body',
    };

    const delivered = tracker.begin('/api/send_mail', payload);
    tracker.succeeded(delivered);
    assert.notEqual(tracker.begin('/api/send_mail', payload).key, delivered.key);

    const rejected = tracker.begin('/api/send_mail', { ...payload, subject: 'invalid' });
    tracker.failed(rejected, new Error('[400]: invalid input'));
    assert.notEqual(
        tracker.begin('/api/send_mail', { ...payload, subject: 'invalid' }).key,
        rejected.key,
    );
});

test('both Vue composers send the attempt UUID and settle it', () => {
    const sources = [
        readFileSync(
            new URL('../../frontend/src/views/index/SendMail.vue', import.meta.url),
            'utf8',
        ),
        readFileSync(
            new URL('../../frontend/src/views/admin/SendMail.vue', import.meta.url),
            'utf8',
        ),
    ];
    for (const source of sources) {
        assert.match(source, /idempotency_key:\s*attempt\.key/);
        assert.match(source, /outboundRequests\.succeeded\(attempt\)/);
        assert.match(source, /outboundRequests\.failed\(attempt,\s*error\)/);
    }
});
