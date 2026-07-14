export const flagColumns = {
    '\\Seen': 'seen',
    '\\Answered': 'answered',
    '\\Flagged': 'flagged',
    '\\Deleted': 'deleted',
    '\\Draft': 'draft',
} as const;

export type MailFlag = keyof typeof flagColumns;
export type Mailbox = 'INBOX' | 'SENT';

export const normalizeFlags = (value: unknown): MailFlag[] => {
    if (!Array.isArray(value)) throw new Error('flags must be an array');
    const unique = new Set<MailFlag>();
    for (const flag of value) {
        if (typeof flag !== 'string' || !Object.hasOwn(flagColumns, flag)) {
            throw new Error('unsupported mail flag');
        }
        unique.add(flag as MailFlag);
    }
    return [...unique];
};

export const normalizeMailbox = (value: unknown): Mailbox => {
    if (typeof value !== 'string') {
        throw new Error('unsupported mailbox');
    }
    const mailbox = value.trim().toUpperCase();
    if (mailbox !== 'INBOX' && mailbox !== 'SENT') {
        throw new Error('unsupported mailbox');
    }
    return mailbox;
};
