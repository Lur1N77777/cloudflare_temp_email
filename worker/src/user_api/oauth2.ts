import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt'

import i18n from '../i18n';
import { getJsonSetting, getMailDomain, getStringValue, getUserRoles, includesDomain } from '../utils';
import { UserOauth2Settings } from '../models';
import { CONSTANTS } from '../constants';
import { normalizeUserEmail } from './registration_security';
import { buildUserTokenPayload, loadUserAuthRecord } from '../auth_tokens';


export default {
    getOauth2LoginUrl: async (c: Context<HonoCustomType>) => {
        const settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
        const { clientID, state } = c.req.query();
        const msgs = i18n.getMessagesbyContext(c);
        const setting = settings?.find(s => s.clientID === clientID);
        if (!setting) {
            return c.text(msgs.Oauth2ClientIDNotFoundMsg, 400);
        }
        const url = `${setting.authorizationURL}?client_id=${setting.clientID}&response_type=code&redirect_uri=${setting.redirectURL}&scope=${setting.scope}&state=${state}`
        return c.json({ url });
    },
    oauth2Login: async (c: Context<HonoCustomType>) => {
        const { clientID, code } = await c.req.json<{ clientID?: string, code?: string }>();
        const msgs = i18n.getMessagesbyContext(c);
        if (!clientID || !code) {
            return c.text(msgs.Oauth2CliendIDOrCodeMissingMsg, 400);
        }
        const settings = await getJsonSetting<UserOauth2Settings[]>(c, CONSTANTS.OAUTH2_SETTINGS_KEY);
        const setting = settings?.find(s => s.clientID === clientID);
        if (!setting) {
            return c.text(msgs.Oauth2ClientIDNotFoundMsg, 400);
        }
        const params = {
            code,
            client_id: setting.clientID,
            client_secret: setting.clientSecret,
            grant_type: 'authorization_code',
            redirect_uri: setting.redirectURL,
        }
        const res = await fetch(setting.accessTokenURL, {
            method: 'POST',
            body: setting.accessTokenFormat === 'json'
                ? JSON.stringify(params) :
                new URLSearchParams(params).toString(),
            headers: {
                'Content-Type': setting.accessTokenFormat === 'json'
                    ? 'application/json'
                    : 'application/x-www-form-urlencoded',
                "Accept": "application/json"
            }
        })
        if (!res.ok) {
            console.error(`Failed to get access token: ${res.status} ${res.statusText} ${await res.text()}`)
            return c.text(msgs.Oauth2FailedGetAccessTokenMsg, 400);
        }
        const resJson = await res.json();
        const { access_token, token_type } = resJson as { access_token: string, token_type?: string };
        const userRes = await fetch(setting.userInfoURL, {
            headers: {
                "Authorization": `${token_type || 'Bearer'} ${access_token}`,
                "Accept": "application/json",
                "User-Agent": "Cloudflare Workers"
            }
        })
        if (!userRes.ok) {
            console.error(`Failed to get user info: ${userRes.status} ${userRes.statusText} ${await userRes.text()}`)
            return c.text(msgs.Oauth2FailedGetUserInfoMsg, 400);
        }
        const userInfo = await userRes.json<any>()

        const rawEmail = await (async () => {
            if (setting.userEmailKey.startsWith("$")) {
                const { JSONPath } = await import('jsonpath-plus');
                const email = JSONPath({
                    path: setting.userEmailKey,
                    json: userInfo,
                })
                if (email && Array.isArray(email) && email.length > 0) {
                    return email[0];
                }
            }
            const { [setting.userEmailKey]: email } = userInfo as { [key: string]: string };
            return email;
        })()

        if (!rawEmail) {
            return c.text(msgs.Oauth2FailedGetUserEmailMsg, 400);
        }

        // Apply email format transformation if enabled
        const formattedEmail = (() => {
            const rawEmailStr = String(rawEmail).slice(0, 256).trim();  // 限制长度防止 ReDoS
            if (!setting.enableEmailFormat || !setting.userEmailFormat) {
                return rawEmailStr;
            }
            try {
                const regex = new RegExp(setting.userEmailFormat);
                const replacement = setting.userEmailReplace || '$1';
                return rawEmailStr.replace(regex, replacement).trim();
            } catch (e) {
                console.error(`Invalid regex in userEmailFormat: ${setting.userEmailFormat}`, e);
                return rawEmailStr;
            }
        })();

        let email: string;
        try {
            email = normalizeUserEmail(formattedEmail);
        } catch {
            return c.text(msgs.Oauth2FailedGetUserEmailMsg, 400);
        }
        // check email in mail allow list
        const mailDomain = getMailDomain(email);
        if (setting.enableMailAllowList && !includesDomain(setting.mailAllowList, mailDomain)) {
            return c.text(`${msgs.UserMailDomainMustInMsg} ${JSON.stringify(setting.mailAllowList, null, 2)}`, 400)
        }
        const defaultRole = getStringValue(c.env.USER_DEFAULT_ROLE);
        if (defaultRole && !getUserRoles(c).some((role) => role.role === defaultRole)) {
            return c.text(msgs.InvalidUserDefaultRoleMsg, 500);
        }
        const statements = [
            c.env.DB.prepare(
                `INSERT INTO users (user_email, password, user_info)`
                + ` SELECT ?, '', ? WHERE NOT EXISTS (`
                + `SELECT 1 FROM users WHERE user_email = ? COLLATE NOCASE)`
            ).bind(email, JSON.stringify(userInfo), email),
            c.env.DB.prepare(
                `UPDATE users SET updated_at = datetime('now')`
                + ` WHERE user_email = ? COLLATE NOCASE`
            ).bind(email),
        ];
        if (defaultRole) {
            statements.push(c.env.DB.prepare(
                `INSERT INTO user_roles (user_id, role_text)`
                + ` SELECT id, ? FROM users WHERE user_email = ? COLLATE NOCASE`
                + ` ON CONFLICT(user_id) DO NOTHING`
            ).bind(defaultRole, email));
        }
        try {
            const results = await c.env.DB.batch(statements);
            if (!results.every((result) => result.success)) {
                return c.text(msgs.FailedToRegisterMsg, 500);
            }
        } catch (error) {
            console.error('Atomic OAuth user registration failed', error);
            return c.text(msgs.FailedToRegisterMsg, 500);
        }
        const { id: user_id } = await c.env.DB.prepare(
            `SELECT id FROM users WHERE user_email = ? COLLATE NOCASE`
        ).bind(email).first() || {};
        if (!user_id) {
            return c.text(msgs.UserNotFoundMsg, 400)
        }
        const authUser = await loadUserAuthRecord(c.env.DB, Number(user_id));
        if (!authUser) return c.text(msgs.UserNotFoundMsg, 400);
        const jwt = await Jwt.sign(
            buildUserTokenPayload(authUser),
            c.env.JWT_SECRET,
            "HS256",
        )
        return c.json({
            jwt: jwt
        })
    }
}
