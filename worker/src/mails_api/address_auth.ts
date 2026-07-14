import { Context } from 'hono';
import i18n from '../i18n';
import utils, { checkCfTurnstile, checkUserPassword, getBooleanValue } from '../utils';
import { Jwt } from 'hono/utils/jwt';
import {
    buildAddressTokenPayload,
    rotateAddressPassword,
} from '../auth_tokens';
import { hashUserPassword, verifyUserPassword } from '../security/user_password';
import {
    checkLoginThrottle,
    clearAccountLoginFailures,
    recordLoginFailure,
    releaseLoginReservations,
} from '../security/login_throttle';

export default {
    // 修改地址密码
    changePassword: async (c: Context<HonoCustomType>) => {
        const { new_password } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        const { address, address_id, token_version } = c.get("jwtPayload");

        // 检查功能是否启用
        if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) {
            return c.text(msgs.PasswordChangeDisabledMsg, 403);
        }

        if (typeof new_password !== 'string') {
            return c.text(msgs.NewPasswordRequiredMsg, 400);
        }
        try {
            checkUserPassword(new_password);
        } catch {
            return c.text(msgs.NewPasswordRequiredMsg, 400);
        }

        if (!address || !address_id) {
            return c.text(msgs.InvalidAddressTokenMsg, 400);
        }

        // The client sends a SHA-256 value; apply a salted server-side KDF so a
        // database leak cannot replay that value directly against this endpoint.
        const storedPassword = await hashUserPassword(new_password);
        const updatedAddress = await rotateAddressPassword(c.env.DB, {
            id: address_id,
            name: address,
            token_version,
        }, storedPassword);

        if (!updatedAddress) {
            return c.text(msgs.FailedUpdatePasswordMsg, 500);
        }

        const jwt = await Jwt.sign(
            buildAddressTokenPayload(updatedAddress),
            c.env.JWT_SECRET,
            "HS256",
        );

        return c.json({ success: true, jwt });
    },

    // 地址密码登录
    login: async (c: Context<HonoCustomType>) => {
        const { email, password, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);

        // 检查功能是否启用
        if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) {
            return c.text(msgs.PasswordLoginDisabledMsg, 403);
        }

        if (typeof email !== 'string' || typeof password !== 'string') {
            return c.text(msgs.EmailPasswordRequiredMsg, 400);
        }
        // check cf turnstile if global turnstile is enabled
        if (utils.isGlobalTurnstileEnabled(c)) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch (error) {
                return c.text(msgs.TurnstileCheckFailedMsg, 400)
            }
        }
        const throttle = await checkLoginThrottle(c, 'address', String(email));
        if (!throttle.allowed) {
            c.header('retry-after', String(throttle.retryAfter));
            return c.text('Too many login attempts', 429);
        }

        let throttleFinalized = false;
        try {
            // 查找地址
            const address = await c.env.DB.prepare(
                `SELECT * FROM address WHERE name = ?`
            ).bind(email).first<{
                id: number;
                name: string;
                password: string | null;
                token_version?: number;
            }>();

            if (!address?.password) {
                await recordLoginFailure(c, 'address', String(email));
                throttleFinalized = true;
                return c.text(msgs.InvalidEmailOrPasswordMsg, 401);
            }

            const passwordResult = await verifyUserPassword(address.password, password);
            if (!passwordResult.valid) {
                await recordLoginFailure(c, 'address', String(email));
                throttleFinalized = true;
                return c.text(msgs.InvalidEmailOrPasswordMsg, 401);
            }
            if (passwordResult.needsUpgrade) {
                const upgradedPassword = await hashUserPassword(password);
                const upgradeResult = await c.env.DB.prepare(
                    `UPDATE address SET password = ?, updated_at = datetime('now')`
                    + ` WHERE id = ? AND password = ? AND token_version = ?`
                ).bind(
                    upgradedPassword,
                    address.id,
                    address.password,
                    address.token_version ?? 0,
                ).run();
                if (!upgradeResult.success || upgradeResult.meta.changes !== 1) {
                    await recordLoginFailure(c, 'address', String(email));
                    throttleFinalized = true;
                    return c.text(msgs.InvalidEmailOrPasswordMsg, 401);
                }
            }
            await clearAccountLoginFailures(c, 'address', String(email));
            throttleFinalized = true;

            // 创建JWT
            const jwt = await Jwt.sign(buildAddressTokenPayload({
                id: address.id,
                name: address.name,
                token_version: address.token_version ?? 0,
            }), c.env.JWT_SECRET, "HS256");

            return c.json({
                jwt: jwt,
                address: address.name
            });
        } catch (error) {
            if (!throttleFinalized) {
                try {
                    await releaseLoginReservations(c, 'address', String(email));
                } catch {
                    console.error('Failed to release address login throttle reservation');
                }
            }
            throw error;
        }
    }
};
