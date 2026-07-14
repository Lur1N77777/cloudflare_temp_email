import { Context } from 'hono'
import { Jwt } from 'hono/utils/jwt'

import i18n from '../i18n'
import { checkUserPassword, getBooleanValue } from '../utils'
import { deleteAddressWithData, newAddress, handleListQuery } from '../common'
import {
    buildAddressTokenPayload,
    loadAddressAuthRecord,
    resetAddressPassword,
} from '../auth_tokens'
import { hashUserPassword } from '../security/user_password';

const listAddresses = async (c: Context<HonoCustomType>) => {
    const { limit, offset, query, sort_by, sort_order } = c.req.query();
    const allowedSortColumns: Record<string, string> = {
        'id': 'a.id',
        'name': 'a.name',
        'created_at': 'a.created_at',
        'updated_at': 'a.updated_at',
        'source_meta': 'a.source_meta',
        'mail_count': 'mail_count',
        'send_count': 'send_count',
    };
    const sortColumn = Object.hasOwn(allowedSortColumns, sort_by) ? allowedSortColumns[sort_by] : 'a.id';
    const sortDirection = sort_order === 'ascend' ? 'asc' : 'desc';
    const orderBy = `${sortColumn} ${sortDirection}`;
    if (query) {
        // D1 caps LIKE pattern length at 50 bytes; fall back to instr() for
        // longer queries to avoid "LIKE or GLOB pattern too complex" (#956).
        const useInstr = new TextEncoder().encode(query).length + 2 > 50;
        const whereClause = useInstr ? `instr(name, ?) > 0` : `name like ?`;
        const param = useInstr ? query : `%${query}%`;
        return await handleListQuery(c,
            `SELECT a.*,`
            + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
            + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
            + ` FROM address a`
            + ` where ${whereClause}`,
            `SELECT count(*) as count FROM address where ${whereClause}`,
            [param], limit, offset, orderBy, ['password']
        );
    }
    return await handleListQuery(c,
        `SELECT a.*,`
        + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
        + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
        + ` FROM address a`,
        `SELECT count(*) as count FROM address`,
        [], limit, offset, orderBy, ['password']
    );
};

const createNewAddress = async (c: Context<HonoCustomType>) => {
    const { name, domain, enablePrefix, enableRandomSubdomain } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (!name) {
        return c.text(msgs.RequiredFieldMsg, 400)
    }
    try {
        const res = await newAddress(c, {
            name, domain, enablePrefix,
            enableRandomSubdomain: getBooleanValue(enableRandomSubdomain),
            checkLengthByConfig: false,
            addressPrefix: null,
            checkAllowDomains: false,
            enableCheckNameRegex: false,
            sourceMeta: 'admin'
        });
        return c.json(res);
    } catch (e) {
        return c.text(`${msgs.FailedCreateAddressMsg}: ${(e as Error).message}`, 400)
    }
};

const deleteAddress = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    if (!/^\d+$/.test(id) || Number(id) <= 0) {
        return c.text(msgs.AddressNotFoundMsg, 404);
    }
    try {
        await deleteAddressWithData(c, null, Number(id), { skipPermissionCheck: true });
    } catch (error) {
        console.error('Admin address deletion failed', error);
        return c.text(msgs.OperationFailedMsg, 500)
    }
    return c.json({ success: true })
};

const clearInbox = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM mail_flags WHERE address_id = ? AND mailbox = 'INBOX'`
        ).bind(id),
        c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE address IN`
            + ` (select name from address where id = ?)`
        ).bind(id),
    ]);
    if (!results.every((result) => result.success)) {
        return c.text(msgs.OperationFailedMsg, 500)
    }
    return c.json({ success: true });
};

const clearSentItems = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM mail_flags WHERE address_id = ? AND mailbox = 'SENT'`
        ).bind(id),
        c.env.DB.prepare(
            `DELETE FROM sendbox WHERE address IN`
            + ` (SELECT name FROM address WHERE id = ?)`
        ).bind(id),
    ]);
    if (!results.every((result) => result.success)) {
        return c.text(msgs.OperationFailedMsg, 500)
    }
    return c.json({ success: true });
};

const showPassword = async (c: Context<HonoCustomType>) => {
    const { id } = c.req.param();
    const address = await loadAddressAuthRecord(c.env.DB, Number(id));
    if (!address) {
        const msgs = i18n.getMessagesbyContext(c);
        return c.text(msgs.AddressNotFoundMsg, 404);
    }
    const jwt = await Jwt.sign(
        buildAddressTokenPayload(address),
        c.env.JWT_SECRET,
        "HS256",
    )
    return c.json({ jwt });
};

const resetPassword = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { id } = c.req.param();
    const { password } = await c.req.json();
    // NOTE: Keep the admin API field as password, but the value is a frontend SHA-256 hash.
    if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) {
        return c.text(msgs.PasswordChangeDisabledMsg, 403);
    }
    if (typeof password !== 'string') {
        return c.text(msgs.NewPasswordRequiredMsg, 400);
    }
    try {
        checkUserPassword(password);
    } catch {
        return c.text(msgs.NewPasswordRequiredMsg, 400);
    }
    const storedPassword = await hashUserPassword(password);
    const address = await resetAddressPassword(c.env.DB, Number(id), storedPassword);
    if (!address) {
        return c.text(msgs.FailedUpdatePasswordMsg, 500);
    }
    return c.json({ success: true });
};

export default {
    listAddresses, createNewAddress, deleteAddress, clearInbox, clearSentItems,
    showPassword, resetPassword
};
