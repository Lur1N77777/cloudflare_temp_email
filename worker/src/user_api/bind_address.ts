import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt'

import { getJsonSetting, getMaxAddressCount, isAddressCountLimitReached } from "../utils"
import { unbindTelegramByAddress } from '../telegram_api/common';
import i18n from '../i18n';
import { commonGetUserRole, hideObjectFields } from '../common';
import { buildAddressTokenPayload, loadAddressAuthRecord } from '../auth_tokens';
import { CONSTANTS } from '../constants';
import { UserSettings } from '../models';

const UserBindAddressModule = {
    bind: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address_id } = c.get("jwtPayload");
        return await UserBindAddressModule.bindByID(c, user_id, address_id)
    },
    bindByID: async (
        c: Context<HonoCustomType>,
        user_id: number | string, address_id: number | string
    ) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!address_id || !user_id) {
            return c.text(msgs.NoAddressOrUserTokenMsg, 400)
        }
        // check if address exists
        const db_address_id = await c.env.DB.prepare(
            `SELECT id FROM address where id = ?`
        ).bind(address_id).first("id");
        if (!db_address_id) {
            return c.text(msgs.AddressNotFoundMsg, 400)
        }
        // check if user exists
        const db_user_id = await c.env.DB.prepare(
            `SELECT id FROM users where id = ?`
        ).bind(user_id).first("id");
        if (!db_user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        // check if binded
        const db_user_address_id = await c.env.DB.prepare(
            `SELECT user_id FROM users_address where user_id = ? and address_id = ?`
        ).bind(user_id, address_id).first("user_id");
        if (db_user_address_id) return c.json({ success: true })
        // check if binded address count
        const userRole = c.get("userRolePayload");
        if (await isAddressCountLimitReached(c, user_id, userRole)) {
            return c.text(msgs.MaxAddressCountReachedMsg, 400)
        }
        // bind
        try {
            const { success } = await c.env.DB.prepare(
                `INSERT INTO users_address (user_id, address_id) VALUES (?, ?)`
            ).bind(user_id, address_id).run();
            if (!success) {
                return c.text(msgs.OperationFailedMsg, 500)
            }
        } catch (e) {
            const error = e as Error;
            if (error.message && error.message.includes("UNIQUE")) {
                return c.text(msgs.AddressAlreadyBindedMsg, 400)
            }
            return c.text(msgs.OperationFailedMsg, 500)
        }
        return c.json({ success: true })
    },
    unbind: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get("userPayload");
        const { address_id } = await c.req.json();
        if (!address_id || !user_id) {
            return c.text(msgs.InvalidAddressOrUserTokenMsg, 400)
        }
        // check if address exists
        const db_address_id = await c.env.DB.prepare(
            `SELECT id FROM address where id = ?`
        ).bind(address_id).first("id");
        if (!db_address_id) {
            return c.text(msgs.AddressNotFoundMsg, 400)
        }
        // check if user exists
        const db_user_id = await c.env.DB.prepare(
            `SELECT id FROM users where id = ?`
        ).bind(user_id).first("id");
        if (!db_user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        // unbind
        try {
            const { success } = await c.env.DB.prepare(
                `DELETE FROM users_address where user_id = ? and address_id = ?`
            ).bind(user_id, address_id).run();
            if (!success) {
                return c.text(msgs.OperationFailedMsg, 500)
            }
        } catch (e) {
            return c.text(msgs.OperationFailedMsg, 500)
        }
        return c.json({ success: true })
    },
    getBindedAddresses: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const results = await UserBindAddressModule.getBindedAddressesById(c, user_id);
        return c.json({
            results: results,
        });
    },
    getBindedAddressListById: async (
        c: Context<HonoCustomType>, user_id: number | string
    ): Promise<string[]> => {
        const bindedAddressList = await UserBindAddressModule.getBindedAddressesById(c, user_id);
        return bindedAddressList.map((item) => item.name);
    },
    getBindedAddressesById: async (
        c: Context<HonoCustomType>, user_id: number | string
    ): Promise<{
        id: number;
        name: string;
        mail_count: number;
        send_count: number;
        created_at: string;
        updated_at: string;
    }[]> => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!user_id) {
            throw new Error(msgs.UserNotFoundMsg);
        }
        // select binded address
        const { results } = await c.env.DB.prepare(
            `SELECT a.*,`
            + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
            + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
            + ` FROM address a `
            + ` JOIN users_address ua `
            + ` ON ua.address_id = a.id `
            + ` WHERE ua.user_id = ?`
            + ` ORDER BY a.id DESC`
        ).bind(user_id).all<{
            id: number;
            name: string;
            mail_count: number;
            send_count: number;
            created_at: string;
            updated_at: string;
        }>();
        return (results || []).map((row) => hideObjectFields(row, ['password']));
    },
    getBindedAddressJwt: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { address_id } = c.req.param();
        // check binded
        const { user_id } = c.get("userPayload");
        if (!address_id || !user_id) {
            return c.text(msgs.InvalidAddressOrUserTokenMsg, 400)
        }
        // check users_address if address binded
        const db_user_id = await c.env.DB.prepare(
            `SELECT user_id FROM users_address WHERE address_id = ? and user_id = ?`
        ).bind(address_id, user_id).first("user_id");
        if (!db_user_id) {
            return c.text(msgs.AddressNotBindedMsg, 400)
        }
        // generate jwt
        const address = await loadAddressAuthRecord(c.env.DB, Number(address_id));
        if (!address) {
            return c.text(msgs.AddressNotFoundMsg, 400)
        }
        const jwt = await Jwt.sign(
            buildAddressTokenPayload(address),
            c.env.JWT_SECRET,
            "HS256",
        )
        return c.json({
            jwt: jwt
        })
    },
    transferAddress: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        const { user_id } = c.get("userPayload");
        const { address_id, target_user_email } = await c.req.json();
        if (!Number.isSafeInteger(Number(address_id)) || Number(address_id) <= 0
            || typeof target_user_email !== 'string'
        ) return c.text(msgs.InvalidAddressOrUserTokenMsg, 400);
        // check if address exists
        const address = await c.env.DB.prepare(
            `SELECT name FROM address where id = ?`
        ).bind(address_id).first<string>("name");
        if (!address) {
            return c.text(msgs.AddressNotFoundMsg, 400)
        }
        // check if user exists
        const db_user_id = await c.env.DB.prepare(
            `SELECT id FROM users where id = ?`
        ).bind(user_id).first("id");
        if (!db_user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        // check if target user exists
        const target_user_id = await c.env.DB.prepare(
            `SELECT id FROM users WHERE user_email = ? COLLATE NOCASE`
        ).bind(target_user_email.trim()).first<number>("id");
        if (!target_user_id) {
            return c.text(msgs.TargetUserNotFoundMsg, 400)
        }
        // Resolve the target limit once, then enforce it again inside the ownership UPDATE.
        const userRoleObj = await commonGetUserRole(c, target_user_id);
        const settings = new UserSettings(await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY));
        const maxAddressCount = await getMaxAddressCount(c, userRoleObj?.role, settings);
        const targetAddressCount = await c.env.DB.prepare(
            `SELECT COUNT(*) AS count FROM users_address`
            + ` WHERE user_id = ? AND address_id != ?`
        ).bind(target_user_id, address_id).first<number>('count') || 0;
        if (maxAddressCount > 0 && targetAddressCount >= maxAddressCount) {
            return c.text(msgs.MaxAddressCountReachedMsg, 400)
        }
        // check if binded
        const db_user_address_id = await c.env.DB.prepare(
            `SELECT user_id FROM users_address where user_id = ? and address_id = ?`
        ).bind(user_id, address_id).first("user_id");
        if (!db_user_address_id) return c.text(msgs.AddressNotBindedMsg, 400)
        try {
            const results = await c.env.DB.batch([
                c.env.DB.prepare(
                    `UPDATE users_address SET user_id = ?`
                    + ` WHERE user_id = ? AND address_id = ?`
                    + ` AND (? <= 0 OR (`
                    + `SELECT COUNT(*) FROM users_address`
                    + ` WHERE user_id = ? AND address_id != ?`
                    + `) < ?)`
                ).bind(
                    target_user_id,
                    user_id,
                    address_id,
                    maxAddressCount,
                    target_user_id,
                    address_id,
                    maxAddressCount,
                ),
                c.env.DB.prepare(
                    `UPDATE address SET password = NULL,`
                    + ` token_version = token_version + 1,`
                    + ` updated_at = datetime('now')`
                    + ` WHERE id = ? AND changes() = 1`
                ).bind(address_id),
            ]);
            if (!results.every((result) => result.success)
                || results[0].meta.changes !== 1
                || results[1].meta.changes !== 1
            ) {
                const currentOwner = await c.env.DB.prepare(
                    `SELECT user_id FROM users_address WHERE address_id = ?`
                ).bind(address_id).first<number>('user_id');
                if (String(currentOwner) !== String(user_id)) {
                    return c.text(msgs.AddressNotBindedMsg, 400);
                }
                return c.text(msgs.MaxAddressCountReachedMsg, 400);
            }
        } catch (error) {
            console.error('Atomic address transfer failed', error);
            return c.text(msgs.OperationFailedMsg, 500)
        }

        // Telegram KV cannot join the D1 transaction. The old token is already
        // invalid because token_version was rotated, so cleanup is best effort.
        try {
            await unbindTelegramByAddress(c, address);
        } catch (error) {
            console.error(`Failed to remove Telegram binding for transferred address ${address}`, error);
        }
        return c.json({ success: true })
    }
}

export default UserBindAddressModule;
