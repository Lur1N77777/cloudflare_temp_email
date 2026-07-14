import type { Context } from 'hono';

import {
    flagColumns,
    normalizeFlags,
    normalizeMailbox,
    type Mailbox,
    type MailFlag,
} from './mail_flag_values';

// D1 allows at most 100 bound parameters per statement. Ownership queries
// also bind address/mailbox values, so stay below that hard limit.
export const MAX_FLAG_QUERY_IDS = 90;
export const MAX_FLAG_UPDATES = 40;

type FlagOperation = 'replace' | 'add' | 'remove';
type FlagUpdate = {
    mail_id: number;
    operation?: FlagOperation;
    flags: MailFlag[];
};

const parseMailIds = (value: unknown, maximum: number): number[] => {
    const rawValues = typeof value === 'string' ? value.split(',') : [];
    if (rawValues.length < 1 || rawValues.length > maximum) throw new Error('invalid mail_ids');
    const ids = rawValues.map((item) => Number(item));
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error('invalid mail_ids');
    }
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) throw new Error('duplicate mail_ids');
    return unique;
};

const toFlagValues = (flags: MailFlag[]): number[] => {
    const selected = new Set(flags);
    return Object.keys(flagColumns).map((flag) => selected.has(flag as MailFlag) ? 1 : 0);
};

const buildFlagUpsert = (
    c: Context<HonoCustomType>,
    addressId: number,
    address: string,
    mailbox: Mailbox,
    update: FlagUpdate,
): D1PreparedStatement => {
    const values = toFlagValues(update.flags);
    const columns = Object.values(flagColumns);
    const operation = update.operation || 'replace';
    const insertValues = operation === 'remove' ? columns.map(() => 0) : values;
    let updateClause: string;
    let trailingBindings: number[] = [];
    if (operation === 'replace') {
        updateClause = columns.map((column) => `${column} = excluded.${column}`).join(', ');
    } else if (operation === 'add') {
        updateClause = columns.map(
            (column) => `${column} = MAX(mail_flags.${column}, excluded.${column})`
        ).join(', ');
    } else {
        updateClause = columns.map(
            (column) => `${column} = CASE WHEN ? = 1 THEN 0 ELSE mail_flags.${column} END`
        ).join(', ');
        trailingBindings = values;
    }
    return c.env.DB.prepare(
        `INSERT INTO mail_flags (`
        + `address_id, mailbox, mail_id, ${columns.join(', ')}, updated_at)`
        + ` SELECT ?, ?, id, ${columns.map(() => '?').join(', ')}, CURRENT_TIMESTAMP`
        + (mailbox === 'SENT'
            ? ' FROM sendbox WHERE id = ? AND address = ?'
            : ' FROM raw_mails WHERE id = ? AND address = ?')
        + ` ON CONFLICT(address_id, mailbox, mail_id) DO UPDATE SET `
        + `${updateClause}, updated_at = CURRENT_TIMESTAMP`
    ).bind(
        addressId,
        mailbox,
        ...insertValues,
        update.mail_id,
        address,
        ...trailingBindings,
    );
};

const get = async (c: Context<HonoCustomType>): Promise<Response> => {
    const { address, address_id: addressId } = c.get('jwtPayload');
    let mailbox: Mailbox;
    let mailIds: number[];
    try {
        mailbox = normalizeMailbox(c.req.query('mailbox') ?? 'INBOX');
        mailIds = parseMailIds(c.req.query('mail_ids'), MAX_FLAG_QUERY_IDS);
    } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
    }
    const placeholders = mailIds.map(() => '?').join(', ');
    const statement = mailbox === 'SENT'
        ? c.env.DB.prepare(
            `SELECT mf.mail_id, mf.seen, mf.answered, mf.flagged, mf.deleted, mf.draft`
            + ` FROM mail_flags mf JOIN sendbox sb ON sb.id = mf.mail_id`
            + ` WHERE mf.address_id = ? AND mf.mailbox = ?`
            + ` AND sb.address = ? AND mf.mail_id IN (${placeholders})`
        )
        : c.env.DB.prepare(
            `SELECT mf.mail_id, mf.seen, mf.answered, mf.flagged, mf.deleted, mf.draft`
            + ` FROM mail_flags mf JOIN raw_mails rm ON rm.id = mf.mail_id`
            + ` WHERE mf.address_id = ? AND mf.mailbox = ?`
            + ` AND rm.address = ? AND mf.mail_id IN (${placeholders})`
        );
    const { results } = await statement
        .bind(addressId, mailbox, address, ...mailIds)
        .all<Record<string, unknown>>();
    const flags = (results || []).map((row) => ({
        mail_id: row.mail_id,
        flags: Object.entries(flagColumns)
            .filter(([, column]) => Number(row[column]) === 1)
            .map(([flag]) => flag),
    }));
    return c.json({ results: flags });
};

const patch = async (c: Context<HonoCustomType>): Promise<Response> => {
    const { address, address_id: addressId } = c.get('jwtPayload');
    let mailbox: Mailbox;
    let updates: FlagUpdate[];
    try {
        const body = await c.req.json<{ mailbox?: unknown; updates?: unknown }>();
        mailbox = normalizeMailbox(body.mailbox ?? 'INBOX');
        if (!Array.isArray(body.updates)
            || body.updates.length < 1
            || body.updates.length > MAX_FLAG_UPDATES
        ) throw new Error('invalid updates');
        updates = body.updates.map((rawUpdate) => {
            if (!rawUpdate || typeof rawUpdate !== 'object') throw new Error('invalid update');
            const value = rawUpdate as Record<string, unknown>;
            const mailId = Number(value.mail_id);
            if (!Number.isSafeInteger(mailId) || mailId <= 0) throw new Error('invalid mail_id');
            const operation = value.operation ?? 'replace';
            if (!['replace', 'add', 'remove'].includes(String(operation))) {
                throw new Error('invalid operation');
            }
            return {
                mail_id: mailId,
                operation: operation as FlagOperation,
                flags: normalizeFlags(value.flags),
            };
        });
        if (new Set(updates.map((update) => update.mail_id)).size !== updates.length) {
            throw new Error('duplicate mail_id');
        }
    } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
    }

    const placeholders = updates.map(() => '?').join(', ');
    const ownershipStatement = mailbox === 'SENT'
        ? c.env.DB.prepare(
            `SELECT COUNT(*) AS count FROM sendbox`
            + ` WHERE address = ? AND id IN (${placeholders})`
        )
        : c.env.DB.prepare(
            `SELECT COUNT(*) AS count FROM raw_mails`
            + ` WHERE address = ? AND id IN (${placeholders})`
        );
    const owned = await ownershipStatement
        .bind(address, ...updates.map((update) => update.mail_id))
        .first<number>('count') || 0;
    if (owned !== updates.length) return c.json({ error: 'mail not found' }, 404);

    const results = await c.env.DB.batch(updates.map((update) => buildFlagUpsert(
        c, addressId, address, mailbox, update,
    )));
    if (!results.every((result) => result.success && result.meta.changes === 1)) {
        return c.json({ error: 'failed to update flags' }, 409);
    }
    return c.json({ success: true, updated: updates.length });
};

export default { get, patch };
