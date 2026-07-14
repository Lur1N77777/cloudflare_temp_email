const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export class InvalidIdempotencyKeyError extends Error {
    constructor(message = 'Invalid idempotency key') {
        super(message);
        this.name = 'InvalidIdempotencyKeyError';
    }
}

export const normalizeIdempotencyKey = (value: unknown): string => {
    if (typeof value !== 'string') {
        throw new InvalidIdempotencyKeyError();
    }
    const normalized = value.trim();
    if (
        normalized.length === 0
        || normalized.length > IDEMPOTENCY_KEY_MAX_LENGTH
        || !/^[\x21-\x7e]+$/.test(normalized)
    ) {
        throw new InvalidIdempotencyKeyError();
    }
    return normalized;
};

export const resolveOutboundIdempotencyKey = (
    headerValue: string | undefined,
    bodyValue?: unknown,
): string => {
    const headerKey = typeof headerValue === 'undefined'
        ? null
        : normalizeIdempotencyKey(headerValue);
    const bodyKey = typeof bodyValue === 'undefined'
        ? null
        : normalizeIdempotencyKey(bodyValue);
    if (headerKey && bodyKey && headerKey !== bodyKey) {
        throw new InvalidIdempotencyKeyError();
    }
    return headerKey || bodyKey || `auto-${crypto.randomUUID()}`;
};

const normalizeJsonValue = (
    value: unknown,
    ancestors: Set<object>,
    arrayItem = false,
): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Outbound payload must contain finite JSON numbers');
        }
        return value;
    }
    if (
        typeof value === 'undefined'
        || typeof value === 'function'
        || typeof value === 'symbol'
    ) {
        if (arrayItem) return null;
        throw new TypeError('Outbound payload must be JSON serializable');
    }
    if (typeof value !== 'object') {
        throw new TypeError('Outbound payload must be JSON serializable');
    }
    if (ancestors.has(value)) {
        throw new TypeError('Outbound payload must not contain cycles');
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((entry) => normalizeJsonValue(entry, ancestors, true));
        }
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            const entry = (value as Record<string, unknown>)[key];
            if (
                typeof entry === 'undefined'
                || typeof entry === 'function'
                || typeof entry === 'symbol'
            ) {
                continue;
            }
            normalized[key] = normalizeJsonValue(entry, ancestors);
        }
        return normalized;
    } finally {
        ancestors.delete(value);
    }
};

export const canonicalPayloadHash = async (payload: unknown): Promise<string> => {
    const canonicalPayload = JSON.stringify(normalizeJsonValue(payload, new Set()));
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalPayload),
    );
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
};

export const OUTBOUND_REQUEST_CLAIM_SQL = `
    INSERT INTO outbound_send_requests (
        address,
        idempotency_key,
        payload_hash,
        status,
        updated_at
    ) VALUES (?, ?, ?, 'pending', unixepoch())
    ON CONFLICT(address, idempotency_key) DO NOTHING
`;

export const OUTBOUND_REQUEST_COMPLETE_SQL = `
    UPDATE outbound_send_requests
    SET status = 'completed',
        updated_at = unixepoch(),
        completed_at = unixepoch()
    WHERE address = ?
      AND idempotency_key = ?
      AND payload_hash = ?
      AND status = 'pending'
`;

export const OUTBOUND_REQUEST_FAIL_SQL = `
    UPDATE outbound_send_requests
    SET status = 'failed',
        updated_at = unixepoch(),
        completed_at = unixepoch()
    WHERE address = ?
      AND idempotency_key = ?
      AND payload_hash = ?
      AND status = 'pending'
`;

type OutboundRequestState = 'claimed' | 'pending' | 'completed' | 'failed' | 'conflict';

export type OutboundSendRequest = {
    address: string;
    idempotencyKey: string;
    payloadHash: string;
    state: OutboundRequestState;
};

type OutboundRequestRow = {
    payload_hash: string;
    status: 'pending' | 'completed' | 'failed';
};

const normalizeAddress = (address: string): string => {
    const normalized = address.trim().toLowerCase();
    if (!normalized) {
        throw new TypeError('Outbound sender address is required');
    }
    return normalized;
};

const getChanges = (result: D1Result<unknown>): number => (
    typeof result.meta?.changes === 'number' ? result.meta.changes : 0
);

export const beginOutboundSendRequest = async (
    db: D1Database,
    address: string,
    idempotencyKey: string,
    payload: unknown,
): Promise<OutboundSendRequest> => {
    const normalizedAddress = normalizeAddress(address);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const payloadHash = await canonicalPayloadHash(payload);
    const claim = await db.prepare(OUTBOUND_REQUEST_CLAIM_SQL)
        .bind(normalizedAddress, normalizedKey, payloadHash)
        .run();
    if (!claim.success) {
        throw new Error('Failed to claim outbound send request');
    }
    if (getChanges(claim) === 1) {
        return {
            address: normalizedAddress,
            idempotencyKey: normalizedKey,
            payloadHash,
            state: 'claimed',
        };
    }

    const existing = await db.prepare(
        `SELECT payload_hash, status
         FROM outbound_send_requests
         WHERE address = ? AND idempotency_key = ?`,
    ).bind(normalizedAddress, normalizedKey).first<OutboundRequestRow>();
    if (!existing) {
        throw new Error('Outbound send request claim could not be read');
    }
    return {
        address: normalizedAddress,
        idempotencyKey: normalizedKey,
        payloadHash,
        state: existing.payload_hash === payloadHash ? existing.status : 'conflict',
    };
};

const finishOutboundSendRequest = async (
    db: D1Database,
    request: OutboundSendRequest,
    sql: string,
    operation: string,
): Promise<void> => {
    const result = await db.prepare(sql)
        .bind(request.address, request.idempotencyKey, request.payloadHash)
        .run();
    if (!result.success || getChanges(result) !== 1) {
        throw new Error(`Failed to ${operation} outbound send request`);
    }
};

export const completeOutboundSendRequest = async (
    db: D1Database,
    request: OutboundSendRequest,
): Promise<void> => finishOutboundSendRequest(
    db,
    request,
    OUTBOUND_REQUEST_COMPLETE_SQL,
    'complete',
);

export const failOutboundSendRequest = async (
    db: D1Database,
    request: OutboundSendRequest,
): Promise<void> => finishOutboundSendRequest(
    db,
    request,
    OUTBOUND_REQUEST_FAIL_SQL,
    'fail',
);
