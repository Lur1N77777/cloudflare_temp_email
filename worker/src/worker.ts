import { Context, Hono } from 'hono'
import { cors } from 'hono/cors';
import { Jwt } from 'hono/utils/jwt'

import { api as commonApi } from './commom_api';
import { api as openAuthApi } from './open_api/auth';
import { api as mailsApi } from './mails_api'
import { api as userApi } from './user_api';
import { api as adminApi } from './admin_api';
import { api as apiSendMail } from './mails_api/send_mail_api'
import { api as telegramApi } from './telegram_api'

import i18n from './i18n';
import { email } from './email';
import { scheduled } from './scheduled';
import { getPasswords, getBooleanValue, getDomains, checkIsAdmin } from './utils';
import { checkAccessControl } from './ip_blacklist';
import {
	validateAddressTokenAgainstDb,
	validateUserTokenAgainstDb,
	validateRoleTokenForAddress,
	validateRoleTokenForUser,
} from './auth_tokens';

const API_PATHS = [
	"/api/",
	"/open_api/",
	"/user_api/",
	"/admin/",
	"/telegram/",
	"/external/",
];

const app = new Hono<HonoCustomType>()
//cors
app.use('/*', cors());
// error handler
app.onError((err, c) => {
	const incomingRequestId = c.req.header('x-request-id');
	const requestId = incomingRequestId && /^[a-zA-Z0-9._-]{1,64}$/.test(incomingRequestId)
		? incomingRequestId
		: crypto.randomUUID();
	console.error(`[request_id=${requestId}] Unhandled Worker error`, err);
	c.header('x-request-id', requestId);
	return c.json({ error: 'Internal server error', request_id: requestId }, 500)
})
// global middlewares
app.use('/*', async (c, next) => {

	// check if the request is for static files
	if (c.env.ASSETS && !API_PATHS.some(path => c.req.path.startsWith(path))) {
		const url = new URL(c.req.raw.url);
		if (!url.pathname.includes('.')) {
			url.pathname = ""
		}
		return c.env.ASSETS.fetch(url);
	}

	// save language in context
	const lang = c.req.raw.headers.get("x-lang");
	if (lang) { c.set("lang", lang); }
	const msgs = i18n.getMessages(lang || c.env.DEFAULT_LANG);

	// check header x-custom-auth
	const passwords = getPasswords(c);
	if (!c.req.path.startsWith("/open_api") && !c.req.path.startsWith("/telegram/") && passwords && passwords.length > 0) {
		const auth = c.req.raw.headers.get("x-custom-auth");
		if (!auth || !passwords.includes(auth)) {
			return c.text(msgs.CustomAuthPasswordMsg, 401)
		}
	}

	// rate limit for specific endpoints
	if (
		c.req.path.startsWith("/api/new_address")
		|| c.req.path.startsWith("/api/address_login")
		|| c.req.path.startsWith("/api/send_mail")
		|| c.req.path.startsWith("/external/api/send_mail")
		|| c.req.path.startsWith("/user_api/register")
		|| c.req.path.startsWith("/user_api/login")
		|| c.req.path.startsWith("/user_api/verify_code")
	) {
		const reqIp = c.req.raw.headers.get("cf-connecting-ip")
		if (reqIp && c.env.RATE_LIMITER) {
			const { success } = await c.env.RATE_LIMITER.limit(
				{ key: `${c.req.path}|${reqIp}` }
			)
			if (!success) {
				return c.text(`IP=${reqIp} Rate limit exceeded for ${c.req.path}`, 429)
			}
		}
		// Check access control (blacklist and daily limit)
		const accessControlResponse = await checkAccessControl(c);
		if (accessControlResponse) {
			return accessControlResponse;
		}
	}
	// webhook check
	if (
		c.req.path.startsWith("/api/webhook")
		|| c.req.path.startsWith("/admin/webhook")
		|| c.req.path.startsWith("/admin/mail_webhook")
	) {
		if (!c.env.KV) {
			return c.text(msgs.KVNotAvailableMsg, 400);
		}
		if (!getBooleanValue(c.env.ENABLE_WEBHOOK)) {
			return c.text(msgs.WebhookNotEnabledMsg, 403);
		}
	}
	if (!c.env.DB) {
		return c.text(msgs.DBNotAvailableMsg, 400);
	}
	if (!c.env.JWT_SECRET) {
		return c.text(msgs.JWTSecretNotSetMsg, 400);
	}
	await next()
});

const checkUserPayload = async (
	c: Context<HonoCustomType>
): Promise<UserPayload | undefined> => {
	try {
		const token = c.req.raw.headers.get("x-user-token");
		if (!token) return;
		const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
		const user = await validateUserTokenAgainstDb(
			c.env.DB,
			payload as Record<string, unknown>,
		);
		if (!user) return;
		const userPayload = {
			...payload,
			typ: 'user',
			sub: String(user.id),
			user_email: user.user_email,
			user_id: user.id,
			token_version: user.token_version,
		} as UserPayload;
		c.set("userPayload", userPayload);
		return userPayload;
	} catch (e) {
		console.error(e);
	}
}

const checkoutUserRolePayload = async (
	c: Context<HonoCustomType>,
	expected: { userId: number } | { addressId: number },
): Promise<string | null> => {
	try {
		const token = c.req.raw.headers.get("x-user-access-token");
		if (!token) return null;
		const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
		const role = "addressId" in expected
			? await validateRoleTokenForAddress(
				c.env.DB,
				payload as Record<string, unknown>,
				expected.addressId,
			)
			: await validateRoleTokenForUser(
				c.env.DB,
				payload as Record<string, unknown>,
				expected.userId,
			);
		if (!role) return null;
		c.set("userRolePayload", role);
		return role;
	} catch (e) {
		console.error(e);
		return null;
	}
}

const checkAddressPayload = async (
	c: Context<HonoCustomType>,
): Promise<boolean> => {
	const authorization = c.req.raw.headers.get("authorization");
	const match = authorization?.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	const payload = await Jwt.verify(match[1], c.env.JWT_SECRET, "HS256");
	const address = await validateAddressTokenAgainstDb(
		c.env.DB,
		payload as Record<string, unknown>,
	);
	if (!address) return false;
	c.set("jwtPayload", {
		...payload,
		address: address.name,
		address_id: address.id,
		token_version: address.token_version,
	} as JwtPayload);
	return true;
}

// api auth
app.use('/api/*', async (c, next) => {
	if (c.req.path.startsWith("/api/new_address")) {
		const user = await checkUserPayload(c);
		if (user) {
			await checkoutUserRolePayload(c, { userId: user.user_id });
		}
		await next();
		return;
	}
	if (c.req.path.startsWith("/api/address_login")) {
		await next();
		return;
	}

	try {
		if (!await checkAddressPayload(c)) {
			throw new Error("Address credential does not match the current database row");
		}
		const addressPayload = c.get("jwtPayload");
		if (c.req.path.startsWith("/api/settings")
			|| c.req.path.startsWith("/api/send_mail")
		) {
			await checkoutUserRolePayload(c, { addressId: addressPayload.address_id });
		}
		await next();
		return;
	} catch (e) {
		console.warn(e);
		const lang = c.get("lang") || c.env.DEFAULT_LANG;
		const msgs = i18n.getMessages(lang);
		return c.text(msgs.InvalidAddressCredentialMsg, 401)
	}
});
// user_api auth
app.use('/user_api/*', async (c, next) => {
	if (
		c.req.path.startsWith("/user_api/open_settings")
		|| c.req.path.startsWith("/user_api/register")
		|| c.req.path.startsWith("/user_api/login")
		|| c.req.path.startsWith("/user_api/verify_code")
		|| c.req.path.startsWith("/user_api/passkey/authenticate_")
		|| c.req.path.startsWith("/user_api/oauth2")
	) {
		await next();
		return;
	}

	const lang = c.req.raw.headers.get("x-lang") || c.env.DEFAULT_LANG;
	const msgs = i18n.getMessages(lang);

	const user = await checkUserPayload(c);
	if (!user) {
		return c.text(msgs.UserTokenExpiredMsg, 401)
	}
	if (c.req.path.startsWith("/user_api/bind_address")) {
		await checkoutUserRolePayload(c, { userId: user.user_id });
	}
	if (c.req.path.startsWith('/user_api/bind_address')
		&& c.req.method === 'POST'
	) {
		try {
			if (!await checkAddressPayload(c)) {
				return c.text(msgs.InvalidAddressCredentialMsg, 401);
			}
		} catch (e) {
			console.warn(e);
			return c.text(msgs.InvalidAddressCredentialMsg, 401);
		}
	}
	await next();
});
// admin auth
app.use('/admin/*', async (c, next) => {

	// check header x-admin-auth
	if (checkIsAdmin(c)) {
		await next();
		return;
	}
	const lang = c.req.raw.headers.get("x-lang") || c.env.DEFAULT_LANG;
	const msgs = i18n.getMessages(lang);
	// check if user is admin
	const access_token = c.req.raw.headers.get("x-user-access-token");
	if (c.env.ADMIN_USER_ROLE && access_token) {
		try {
			const payload = await Jwt.verify(access_token, c.env.JWT_SECRET, "HS256");
			if (!Number.isSafeInteger(payload.user_id)) {
				return c.text(msgs.UserAcceesTokenExpiredMsg, 401);
			}
			const role = await validateRoleTokenForUser(
				c.env.DB,
				payload as Record<string, unknown>,
				Number(payload.user_id),
			);
			if (role !== c.env.ADMIN_USER_ROLE) {
				return c.text(msgs.UserRoleIsNotAdminMsg, 401)
			}
			await next();
			return;
		} catch (e) {
			console.error(e);
		}
	}

	// disable admin api check
	if (getBooleanValue(c.env.DISABLE_ADMIN_PASSWORD_CHECK)) {
		await next();
		return;
	}

	return c.text(msgs.NeedAdminPasswordMsg, 401)
});


app.route('/', commonApi)
app.route('/', openAuthApi)
app.route('/', mailsApi)
app.route('/', userApi)
app.route('/', adminApi)
app.route('/', apiSendMail)
app.route('/', telegramApi)

const health_check = async (c: Context<HonoCustomType>) => {
	const lang = c.req.raw.headers.get("x-lang") || c.env.DEFAULT_LANG;
	const msgs = i18n.getMessages(lang);
	if (!c.env.DB) {
		return c.text(msgs.DBNotAvailableMsg, 400);
	}
	if (!c.env.JWT_SECRET) {
		return c.text(msgs.JWTSecretNotSetMsg, 400);
	}
	if (getDomains(c).length === 0) {
		return c.text(msgs.DomainsNotSetMsg, 400);
	}
	return c.text("OK");
}

app.get('/', health_check)
app.get('/health_check', health_check)
app.all('/*', async c => c.text("Not Found", 404))


export default {
	fetch: app.fetch,
	email: email,
	scheduled: scheduled,
}
