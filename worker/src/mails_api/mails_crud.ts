import { Context } from 'hono'

import i18n from '../i18n';
import { getBooleanValue } from '../utils';
import { handleMailListQuery, deleteAddressWithData, updateAddressUpdatedAt } from '../common'
import { resolveRawEmailList, resolveRawEmailRow } from '../gzip'
import type { RawMailRow } from '../models';
import { getSendBalanceState } from './send_balance';
import { normalizeMailbox, type Mailbox } from './mail_flag_values';

const MAX_MAIL_ID_PAGE_SIZE = 200;
// Bound decompression/JSON memory for large RFC 822 messages.
const MAX_MAIL_DETAIL_IDS = 10;

type MailIdRow = {
    id: number;
    message_id: string | null;
    source: string | null;
    address: string;
    metadata: string | null;
    created_at: string;
};

const parsePositiveMailIds = (value: unknown, maximum: number): number[] => {
    if (typeof value !== 'string') throw new Error('Invalid mail IDs');
    const values = value.split(',');
    if (values.length < 1 || values.length > maximum) throw new Error('Invalid mail IDs');
    const ids = values.map((item) => Number(item));
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error('Invalid mail IDs');
    }
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate mail IDs');
    return ids;
};

const listMails = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    if (!address) {
        return c.json({ "error": "No address" }, 400)
    }
    const { limit, offset } = c.req.query();
    if (Number.parseInt(offset) <= 0) updateAddressUpdatedAt(c, address);
    return await handleMailListQuery(c,
        `SELECT * FROM raw_mails where address = ?`,
        `SELECT count(*) as count FROM raw_mails where address = ?`,
        [address], limit, offset
    );
};

const listMailIds = async (c: Context<HonoCustomType>) => {
    const { address } = c.get('jwtPayload');
    if (!address) return c.json({ error: 'No address' }, 400);
    const {
        limit: rawLimit,
        before_id: rawBeforeId,
        mailbox: rawMailbox,
    } = c.req.query();
    const limit = Number(rawLimit ?? 100);
    const beforeId = rawBeforeId === undefined ? null : Number(rawBeforeId);
    let mailbox: Mailbox;
    try {
        mailbox = normalizeMailbox(rawMailbox ?? 'INBOX');
    } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MAIL_ID_PAGE_SIZE) {
        return c.json({ error: 'Invalid limit' }, 400);
    }
    if (beforeId !== null && (!Number.isSafeInteger(beforeId) || beforeId <= 0)) {
        return c.json({ error: 'Invalid cursor' }, 400);
    }
    if (beforeId === null) updateAddressUpdatedAt(c, address);

    const queryLimit = limit + 1;
    let statement: D1PreparedStatement;
    if (mailbox === 'SENT') {
        statement = beforeId === null
            ? c.env.DB.prepare(
                `SELECT id, NULL AS message_id, NULL AS source, address,`
                + ` NULL AS metadata, created_at FROM sendbox`
                + ` WHERE address = ? ORDER BY id DESC LIMIT ?`
            ).bind(address, queryLimit)
            : c.env.DB.prepare(
                `SELECT id, NULL AS message_id, NULL AS source, address,`
                + ` NULL AS metadata, created_at FROM sendbox`
                + ` WHERE address = ? AND id < ? ORDER BY id DESC LIMIT ?`
            ).bind(address, beforeId, queryLimit);
    } else {
        statement = beforeId === null
            ? c.env.DB.prepare(
                `SELECT id, message_id, source, address, metadata, created_at`
                + ` FROM raw_mails WHERE address = ?`
                + ` ORDER BY id DESC LIMIT ?`
            ).bind(address, queryLimit)
            : c.env.DB.prepare(
                `SELECT id, message_id, source, address, metadata, created_at`
                + ` FROM raw_mails WHERE address = ? AND id < ?`
                + ` ORDER BY id DESC LIMIT ?`
            ).bind(address, beforeId, queryLimit);
    }
    const { results } = await statement.all<MailIdRow>();
    const hasMore = (results || []).length > limit;
    const rows = (results || []).slice(0, limit);
    const nextCursor = hasMore ? rows[rows.length - 1]?.id ?? null : null;
    const count = beforeId === null
        ? await (
            mailbox === 'SENT'
                ? c.env.DB.prepare(
                    `SELECT COUNT(*) AS count FROM sendbox WHERE address = ?`
                )
                : c.env.DB.prepare(
                    `SELECT COUNT(*) AS count FROM raw_mails WHERE address = ?`
                )
        ).bind(address).first<number>('count') || 0
        : 0;
    return c.json({
        results: rows,
        count,
        next_cursor: nextCursor,
        has_more: hasMore,
    });
};

const getMail = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload")
    const { mail_id } = c.req.param();
    const id = Number(mail_id);
    if (!Number.isSafeInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid mail ID' }, 400);
    }
    let mailbox: Mailbox;
    try {
        mailbox = normalizeMailbox(c.req.query('mailbox') ?? 'INBOX');
    } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
    }
    if (mailbox === 'SENT') {
        const sent = await c.env.DB.prepare(
            `SELECT * FROM sendbox WHERE id = ? AND address = ?`
        ).bind(id, address).first();
        return c.json(sent || null);
    }
    const result = await c.env.DB.prepare(
        `SELECT * FROM raw_mails WHERE id = ? AND address = ?`
    ).bind(id, address).first<RawMailRow>();
    if (!result) return c.json(null);
    return c.json(await resolveRawEmailRow(result));
};

const getMailDetails = async (c: Context<HonoCustomType>) => {
    const { address } = c.get('jwtPayload');
    let mailbox: Mailbox;
    let mailIds: number[];
    try {
        mailbox = normalizeMailbox(c.req.query('mailbox') ?? 'INBOX');
        mailIds = parsePositiveMailIds(
            c.req.query('mail_ids'),
            MAX_MAIL_DETAIL_IDS,
        );
    } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
    }
    const placeholders = mailIds.map(() => '?').join(', ');
    if (mailbox === 'SENT') {
        const { results } = await c.env.DB.prepare(
            `SELECT * FROM sendbox WHERE address = ?`
            + ` AND id IN (${placeholders}) ORDER BY id DESC`
        ).bind(address, ...mailIds).all();
        return c.json({ results: results || [] });
    }
    const { results } = await c.env.DB.prepare(
        `SELECT * FROM raw_mails WHERE address = ?`
        + ` AND id IN (${placeholders}) ORDER BY id DESC`
    ).bind(address, ...mailIds).all<RawMailRow>();
    return c.json({ results: await resolveRawEmailList(results || []) });
};

const deleteMail = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { id } = c.req.param();
    const { address_id } = c.get('jwtPayload');
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM mail_flags`
            + ` WHERE address_id = ? AND mailbox = 'INBOX' AND mail_id = ?`
        ).bind(address_id, id),
        c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ? AND address = ? COLLATE NOCASE`
        ).bind(id, address),
    ]);
    return c.json({ success: results.every((result) => result.success) });
};

const getSettings = async (c: Context<HonoCustomType>) => {
    const { address, address_id } = c.get("jwtPayload")
    const msgs = i18n.getMessagesbyContext(c);
    if (address_id && address_id > 0) {
        try {
            const db_address_id = await c.env.DB.prepare(
                `SELECT id FROM address where id = ? `
            ).bind(address_id).first("id");
            if (!db_address_id) {
                return c.text(msgs.InvalidAddressMsg, 400)
            }
        } catch (error) {
            return c.text(msgs.InvalidAddressMsg, 400)
        }
    }
    try {
        if (!address_id) {
            const db_address_id = await c.env.DB.prepare(
                `SELECT id FROM address where name = ? `
            ).bind(address).first("id");
            if (!db_address_id) {
                return c.text(msgs.InvalidAddressMsg, 400)
            }
        }
    } catch (error) {
        return c.text(msgs.InvalidAddressMsg, 400)
    }

    updateAddressUpdatedAt(c, address);

    const { balance } = await getSendBalanceState(c, address);
    return c.json({
        address: address,
        send_balance: balance || 0,
    });
};

const deleteAddress = async (c: Context<HonoCustomType>) => {
    const { address, address_id } = c.get("jwtPayload")
    const success = await deleteAddressWithData(c, address, address_id);
    return c.json({ success });
};

const clearInbox = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address, address_id } = c.get("jwtPayload")
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM mail_flags WHERE address_id = ? AND mailbox = 'INBOX'`
        ).bind(address_id),
        c.env.DB.prepare(`DELETE FROM raw_mails WHERE address = ?`).bind(address),
    ]);
    if (!results.every((result) => result.success)) {
        return c.text(msgs.FailedClearInboxMsg, 500)
    }
    return c.json({ success: true });
};

const clearSentItems = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address, address_id } = c.get("jwtPayload")
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM mail_flags WHERE address_id = ? AND mailbox = 'SENT'`
        ).bind(address_id),
        c.env.DB.prepare(`DELETE FROM sendbox WHERE address = ?`).bind(address),
    ]);
    if (!results.every((result) => result.success)) {
        return c.text(msgs.FailedClearSentItemsMsg, 500)
    }
    return c.json({ success: true });
};

export default {
    listMails,
    listMailIds,
    getMail,
    getMailDetails,
    deleteMail,
    getSettings,
    deleteAddress,
    clearInbox,
    clearSentItems,
};
