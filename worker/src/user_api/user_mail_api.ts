import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import UserBindAddressModule from "./bind_address";
import { getBooleanValue } from "../utils";

export default {
    getMails: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address, limit, offset } = c.req.query();
        const bindedAddressList = await UserBindAddressModule.getBindedAddressListById(c, user_id);
        const addressList = address ? bindedAddressList.filter((item) => item == address) : bindedAddressList;
        const addressQuery = `address IN (${addressList.map(() => "?").join(",")})`;
        const addressParams = addressList;

        // user must have at least one binded address to query mails
        if (addressList.length <= 0) {
            return c.json({ results: [], count: 0 });
        }

        const filterQuerys = [addressQuery].filter((item) => item).join(" and ");
        const finalQuery = filterQuerys.length > 0 ? `where ${filterQuerys}` : "";
        const filterParams = [...addressParams]
        return await handleMailListQuery(c,
            `SELECT * FROM raw_mails ${finalQuery}`,
            `SELECT count(*) as count FROM raw_mails ${finalQuery}`,
            filterParams, limit, offset
        );
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
            return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
        }
        const { id } = c.req.param();
        const { user_id } = c.get("userPayload");
        const results = await c.env.DB.batch([
            c.env.DB.prepare(
                `DELETE FROM mail_flags WHERE mailbox = 'INBOX' AND mail_id = ?`
                + ` AND address_id IN (`
                + `SELECT a.id FROM address a`
                + ` JOIN users_address ua ON ua.address_id = a.id`
                + ` JOIN raw_mails rm ON rm.id = ?`
                + ` AND rm.address = a.name COLLATE NOCASE`
                + ` WHERE ua.user_id = ?)`
            ).bind(id, id, user_id),
            c.env.DB.prepare(
                `DELETE FROM raw_mails WHERE id = ? AND EXISTS (`
                + `SELECT 1 FROM address a`
                + ` JOIN users_address ua ON ua.address_id = a.id`
                + ` WHERE ua.user_id = ?`
                + ` AND a.name = raw_mails.address COLLATE NOCASE)`
            ).bind(id, user_id),
        ]);
        return c.json({
            success: results.every((result) => result.success)
        })
    }
}
