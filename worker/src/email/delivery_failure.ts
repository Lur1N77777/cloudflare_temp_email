const normalizeMailbox = (value: string): string => value.trim().toLowerCase();

export const buildInboundDeliveryKey = async (
    recipient: string,
    sender: string,
    messageId: string | null,
): Promise<string | null> => {
    const normalizedMessageId = messageId?.trim();
    if (!normalizedMessageId) return null;

    const input = [
        'v1',
        normalizeMailbox(recipient),
        normalizeMailbox(sender),
        normalizedMessageId,
    ].join('\0');
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(input),
    );
    const hexDigest = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    return `v1:${hexDigest}`;
};

export const temporaryDeliveryFailure = (
    recipient: string,
    error?: unknown,
): never => {
    console.error(`Failed to persist inbound email for ${recipient}`, error);
    throw new Error(`Temporary inbound storage failure for ${recipient}`, {
        cause: error,
    });
};
