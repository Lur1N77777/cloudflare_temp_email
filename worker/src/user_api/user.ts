import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt'

import i18n from '../i18n';
import utils, {
    checkCfTurnstile,
    checkUserPassword,
    getJsonSetting,
    getMailDomain,
    getStringValue,
    getUserRoles,
    includesDomain,
} from "../utils"
import { CONSTANTS } from "../constants";
import { GeoData, UserInfo, UserSettings } from "../models";
import { sendMail } from "../mails_api/send_mail_api";
import { hashUserPassword, verifyUserPassword } from '../security/user_password';
import { buildVerificationMail, VERIFY_CODE_TTL_SECONDS } from "./verification_mail";
import {
    generateRegistrationCode,
    MAX_REGISTRATION_ATTEMPTS,
    normalizeUserEmail,
    REGISTRATION_CHALLENGE_FAILURE_SQL,
    REGISTRATION_CHALLENGE_RESERVE_SQL,
} from './registration_security';
import {
    checkLoginThrottle,
    clearAccountLoginFailures,
    recordLoginFailure,
} from '../security/login_throttle';
import {
    buildUserTokenPayload,
    loadUserAuthRecord,
    type UserAuthRecord,
} from '../auth_tokens';

async function userExists(c: Context<HonoCustomType>, email: string): Promise<boolean> {
    const userId = await c.env.DB.prepare(
        `SELECT id FROM users WHERE user_email = ? COLLATE NOCASE LIMIT 1`
    ).bind(email).first<number | undefined | null>("id");
    return Boolean(userId);
}

const issueUserJwt = async (
    c: Context<HonoCustomType>,
    user: UserAuthRecord,
): Promise<string> => {
    return Jwt.sign(buildUserTokenPayload(user), c.env.JWT_SECRET, 'HS256');
};

const isAllowedRegistrationEmail = (
    settings: UserSettings,
    email: string,
): { allowed: boolean; regexError?: string } => {
    const mailDomain = getMailDomain(email);
    if (settings.enableMailAllowList
        && settings.mailAllowList
        && !includesDomain(settings.mailAllowList, mailDomain)
    ) return { allowed: false };
    if (settings.enableEmailCheckRegex && settings.emailCheckRegex) {
        try {
            if (!new RegExp(settings.emailCheckRegex).test(email)) return { allowed: false };
        } catch (error) {
            console.error('Failed to check user email regex', error);
            return { allowed: false, regexError: settings.emailCheckRegex };
        }
    }
    return { allowed: true };
};

const deleteLegacyVerificationCode = async (
    c: Context<HonoCustomType>,
    normalizedEmail: string,
    rawEmail: string,
): Promise<void> => {
    try {
        await c.env.KV.delete(`temp-mail:${normalizedEmail}`);
        if (rawEmail !== normalizedEmail) await c.env.KV.delete(`temp-mail:${rawEmail}`);
    } catch (error) {
        console.error('Failed to remove legacy registration code from KV', error);
    }
};

export default {
    verifyCode: async (c: Context<HonoCustomType>) => {
        const { email: rawEmail, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        let email: string;
        try {
            email = normalizeUserEmail(rawEmail);
        } catch {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        try {
            await checkCfTurnstile(c, cf_token);
        } catch {
            return c.text(msgs.TurnstileCheckFailedMsg, 400);
        }
        if (await userExists(c, email)) {
            return c.text(msgs.UserAlreadyExistsMsg, 409);
        }
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value);
        const emailCheck = isAllowedRegistrationEmail(settings, email);
        if (!emailCheck.allowed) {
            if (emailCheck.regexError) {
                return c.text(`${msgs.UserEmailNotMatchRegexMsg}: /${emailCheck.regexError}/`, 400);
            }
            return c.text(
                `${msgs.UserMailDomainMustInMsg} ${JSON.stringify(settings.mailAllowList || [], null, 2)}`,
                400,
            );
        }
        if (!settings.verifyMailSender) {
            return c.text(msgs.VerifyMailSenderNotSetMsg, 400);
        }

        const code = generateRegistrationCode();
        const reservation = await c.env.DB.prepare(
            REGISTRATION_CHALLENGE_RESERVE_SQL
        ).bind(email, code, VERIFY_CODE_TTL_SECONDS, email).run();
        if (reservation.meta.changes !== 1) {
            if (await userExists(c, email)) return c.text(msgs.UserAlreadyExistsMsg, 409);
            return c.text(msgs.CodeAlreadySentMsg, 400);
        }

        const verificationMail = buildVerificationMail(code);
        try {
            await sendMail(c, settings.verifyMailSender, {
                from_name: verificationMail.fromName,
                to_name: '',
                to_mail: email,
                subject: verificationMail.subject,
                content: verificationMail.html,
                text: verificationMail.text,
                is_html: true,
            });
        } catch (error) {
            await c.env.DB.prepare(
                `DELETE FROM registration_challenges`
                + ` WHERE email = ? COLLATE NOCASE AND code = ? AND consumed_at IS NULL`
            ).bind(email, code).run();
            console.error('Failed to send registration verification code', error);
            return c.text('Failed to send verify code', 500);
        }

        // Compatibility mirror for codes issued while an older Worker version is still serving traffic.
        try {
            await c.env.KV.put(
                `temp-mail:${email}`,
                code,
                { expirationTtl: VERIFY_CODE_TTL_SECONDS },
            );
        } catch (error) {
            console.error('Failed to mirror registration code to KV', error);
        }
        return c.json({ success: true, expirationTtl: VERIFY_CODE_TTL_SECONDS });
    },

    register: async (c: Context<HonoCustomType>) => {
        const value = await getJsonSetting(c, CONSTANTS.USER_SETTINGS_KEY);
        const settings = new UserSettings(value);
        const msgs = i18n.getMessagesbyContext(c);
        if (!settings.enable) return c.text(msgs.UserRegistrationDisabledMsg, 403);

        const { email: rawEmail, password, code, cf_token } = await c.req.json();
        let email: string;
        try {
            email = normalizeUserEmail(rawEmail);
            checkUserPassword(password);
        } catch {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        if (typeof password !== 'string') return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        if (await userExists(c, email)) return c.text(msgs.UserAlreadyExistsMsg, 409);

        if (!settings.enableMailVerify) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch {
                return c.text(msgs.TurnstileCheckFailedMsg, 400);
            }
        }
        if (settings.enableMailVerify && (typeof code !== 'string' || !/^\d{6}$/.test(code))) {
            return c.text(msgs.InvalidVerifyCodeMsg, 400);
        }

        const emailCheck = isAllowedRegistrationEmail(settings, email);
        if (!emailCheck.allowed) {
            if (emailCheck.regexError) {
                return c.text(`${msgs.UserEmailNotMatchRegexMsg}: /${emailCheck.regexError}/`, 400);
            }
            return c.text(
                `${msgs.UserMailDomainMustInMsg} ${JSON.stringify(settings.mailAllowList || [], null, 2)}`,
                400,
            );
        }

        let challengeSource: 'd1' | 'kv' | null = null;
        if (settings.enableMailVerify) {
            const challenge = await c.env.DB.prepare(
                `SELECT code, expires_at, consumed_at FROM registration_challenges`
                + ` WHERE email = ? COLLATE NOCASE`
            ).bind(email).first<{
                code: string;
                expires_at: number;
                consumed_at: number | null;
            }>();
            const challengeIsLive = challenge
                && challenge.expires_at > Math.floor(Date.now() / 1000)
                && challenge.consumed_at === null;
            if (challengeIsLive && challenge.code === code) {
                challengeSource = 'd1';
            } else if (challenge) {
                if (challengeIsLive) {
                    await c.env.DB.prepare(REGISTRATION_CHALLENGE_FAILURE_SQL).bind(
                        MAX_REGISTRATION_ATTEMPTS,
                        email,
                        code,
                    ).first();
                }
                return c.text(msgs.InvalidVerifyCodeMsg, 400);
            } else {
                const rawEmailText = typeof rawEmail === 'string' ? rawEmail : email;
                const legacyCode = await c.env.KV.get(`temp-mail:${rawEmailText}`)
                    || (rawEmailText === email ? null : await c.env.KV.get(`temp-mail:${email}`));
                if (legacyCode !== code) return c.text(msgs.InvalidVerifyCodeMsg, 400);
                challengeSource = 'kv';
            }
        }

        const defaultRole = getStringValue(c.env.USER_DEFAULT_ROLE);
        if (defaultRole && !getUserRoles(c).some((role) => role.role === defaultRole)) {
            return c.text(msgs.InvalidUserDefaultRoleMsg, 500);
        }

        const reqIp = c.req.raw.headers.get('cf-connecting-ip');
        const userInfo = new UserInfo(new GeoData(reqIp, c.req.raw.cf as any), email);
        const hashedPassword = await hashUserPassword(password);
        let insertSql = `INSERT INTO users (user_email, password, user_info)`
            + ` SELECT ?, ?, ? WHERE NOT EXISTS (`
            + `SELECT 1 FROM users WHERE user_email = ? COLLATE NOCASE)`;
        const insertBindings: unknown[] = [email, hashedPassword, JSON.stringify(userInfo), email];
        if (challengeSource === 'd1') {
            insertSql += ` AND EXISTS (`
                + `SELECT 1 FROM registration_challenges`
                + ` WHERE email = ? COLLATE NOCASE AND code = ?`
                + ` AND expires_at > unixepoch() AND consumed_at IS NULL)`;
            insertBindings.push(email, code);
        }

        const statements = [c.env.DB.prepare(insertSql).bind(...insertBindings)];
        if (defaultRole) {
            statements.push(c.env.DB.prepare(
                `INSERT INTO user_roles (user_id, role_text) VALUES (`
                + `(SELECT id FROM users`
                + ` WHERE user_email = ? COLLATE NOCASE AND changes() = 1), ?)`
            ).bind(email, defaultRole));
        }
        if (challengeSource === 'd1') {
            statements.push(c.env.DB.prepare(
                `UPDATE registration_challenges SET consumed_at = unixepoch()`
                + ` WHERE email = ? COLLATE NOCASE AND code = ?`
                + ` AND expires_at > unixepoch() AND consumed_at IS NULL`
                + ` AND changes() = 1`
            ).bind(email, code));
        }

        try {
            const results = await c.env.DB.batch(statements);
            if (!results.every((result) => result.success)) {
                return c.text(msgs.FailedToRegisterMsg, 500);
            }
            if (results[0].meta.changes !== 1) {
                if (await userExists(c, email)) return c.text(msgs.UserAlreadyExistsMsg, 409);
                return c.text(msgs.InvalidVerifyCodeMsg, 400);
            }
        } catch (error) {
            if (await userExists(c, email)) return c.text(msgs.UserAlreadyExistsMsg, 409);
            console.error('Atomic user registration failed', error);
            return c.text(msgs.FailedToRegisterMsg, 500);
        }

        if (settings.enableMailVerify) {
            await deleteLegacyVerificationCode(
                c,
                email,
                typeof rawEmail === 'string' ? rawEmail : email,
            );
        }
        const registeredUserId = await c.env.DB.prepare(
            `SELECT id FROM users WHERE user_email = ? COLLATE NOCASE`
        ).bind(email).first<number>('id');
        const registeredUser = registeredUserId
            ? await loadUserAuthRecord(c.env.DB, registeredUserId)
            : null;
        if (!registeredUser) return c.text(msgs.FailedToRegisterMsg, 500);
        const jwt = await issueUserJwt(c, registeredUser);
        return c.json({ success: true, jwt });
    },

    login: async (c: Context<HonoCustomType>) => {
        const { email: rawEmail, password, cf_token } = await c.req.json();
        const msgs = i18n.getMessagesbyContext(c);
        let email: string;
        try {
            email = normalizeUserEmail(rawEmail);
            checkUserPassword(password);
        } catch {
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        if (typeof password !== 'string') return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        if (utils.isGlobalTurnstileEnabled(c)) {
            try {
                await checkCfTurnstile(c, cf_token);
            } catch {
                return c.text(msgs.TurnstileCheckFailedMsg, 400);
            }
        }
        const throttle = await checkLoginThrottle(c, 'user', email);
        if (!throttle.allowed) {
            c.header('retry-after', String(throttle.retryAfter));
            return c.text('Too many login attempts', 429);
        }
        const user = await c.env.DB.prepare(
            `SELECT id, user_email, password, token_version FROM users`
            + ` WHERE user_email = ? COLLATE NOCASE`
        ).bind(email).first<{
            id: number;
            user_email: string;
            password: string;
            token_version: number;
        }>();
        if (!user?.password) {
            await recordLoginFailure(c, 'user', email);
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }

        const passwordResult = await verifyUserPassword(user.password, password);
        if (!passwordResult.valid) {
            await recordLoginFailure(c, 'user', email);
            return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        }
        if (passwordResult.needsUpgrade) {
            const upgradedPassword = await hashUserPassword(password);
            const upgradeResult = await c.env.DB.prepare(
                `UPDATE users SET password = ?, updated_at = datetime('now')`
                + ` WHERE id = ? AND password = ? AND token_version = ?`
            ).bind(upgradedPassword, user.id, user.password, user.token_version).run();
            if (!upgradeResult.success || upgradeResult.meta.changes !== 1) {
                await recordLoginFailure(c, 'user', email);
                return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
            }
        }
        await clearAccountLoginFailures(c, 'user', email);

        const authUser = await loadUserAuthRecord(c.env.DB, user.id);
        if (!authUser) return c.text(msgs.InvalidEmailOrPasswordMsg, 400);
        const jwt = await issueUserJwt(c, authUser);
        return c.json({ jwt });
    },
}
