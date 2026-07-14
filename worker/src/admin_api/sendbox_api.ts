import { Context } from 'hono'

import { handleListQuery } from '../common'

const list = async (c: Context<HonoCustomType>) => {
    const { address, limit, offset } = c.req.query();
    if (address) {
        return await handleListQuery(c,
            `SELECT * FROM sendbox where address = ? `,
            `SELECT count(*) as count FROM sendbox where address = ? `,
            [address], limit, offset
        );
    }
    return await handleListQuery(c,
        `SELECT * FROM sendbox `,
        `SELECT count(*) as count FROM sendbox `,
        [], limit, offset
    );
};

const remove = async (c: Context<HonoCustomType>) => {
    const { id } = c.req.param();
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM mail_flags WHERE mailbox = 'SENT' AND mail_id = ?`
            + ` AND address_id IN (`
            + `SELECT a.id FROM address a JOIN sendbox sb ON sb.address = a.name`
            + ` WHERE sb.id = ?)`
        ).bind(id, id),
        c.env.DB.prepare(`DELETE FROM sendbox WHERE id = ?`).bind(id),
    ]);
    return c.json({ success: results.every((result) => result.success) });
};

export default { list, remove };
