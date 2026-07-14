import { Context, Hono } from 'hono'
import { Jwt } from 'hono/utils/jwt'
import { createMimeMessage } from 'mimetext';
import { Resend } from 'resend';
import { WorkerMailer, WorkerMailerOptions } from 'worker-mailer';

import i18n from '../i18n';
import { CONSTANTS } from '../constants'
import { getJsonSetting, getDomains, getBooleanValue, getJsonObjectValue, getDomainMapValue, getMailDomain, includesDomain } from '../utils';
import { GeoData } from '../models'
import { handleListQuery, isSendMailBindingEnabled, updateAddressUpdatedAt } from '../common'
import {
    getSendBalanceState,
    releaseSendBalance,
    requestSendMailAccess,
    reserveSendBalance,
} from './send_balance';
import { releaseSendMailLimit, reserveSendMailLimit } from './send_mail_limit_utils';
import { validateAddressTokenAgainstDb } from '../auth_tokens';
import {
    InvalidIdempotencyKeyError,
    beginOutboundSendRequest,
    completeOutboundSendRequest,
    failOutboundSendRequest,
    resolveOutboundIdempotencyKey,
} from './outbound_idempotency';


export const api = new Hono<HonoCustomType>()

type MailAttachment = {
    filename: string;
    content: string;
    contentType?: string;
    contentId?: string;
};

type SendMailPayload = {
    from_name: string;
    to_mail: string;
    to_name: string;
    subject: string;
    content: string;
    text?: string;
    attachments?: MailAttachment[];
    is_html: boolean;
};

type SendMailRequestPayload = SendMailPayload & {
    idempotency_key?: unknown;
    token?: string;
};

api.post('/api/request_send_mail_access', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { address } = c.get("jwtPayload")
    if (!address) {
        return c.text(msgs.AddressNotFoundMsg, 400)
    }
    const result = await requestSendMailAccess(c, address);
    if (result.status === "ok") {
        return c.json({ status: "ok" })
    }
    if (result.status === "already_requested") {
        return c.text(msgs.AlreadyRequestedMsg, 400)
    }
    return c.text(msgs.OperationFailedMsg, 500)
})

export const sendMailToVerifyAddress = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: SendMailPayload
): Promise<void> => {
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    const msg = createMimeMessage();
    msg.setSender(from_name ? { name: from_name, addr: address } : address);
    msg.setRecipient(to_name ? { name: to_name, addr: to_mail } : to_mail);
    msg.setSubject(subject);
    for (const attachment of reqJson.attachments || []) {
        msg.addAttachment({
            inline: Boolean(attachment.contentId),
            filename: attachment.filename,
            contentType: attachment.contentType || 'application/octet-stream',
            data: attachment.content,
            headers: attachment.contentId ? { 'Content-ID': attachment.contentId } : {},
        });
    }
    if (is_html && reqJson.text) {
        msg.addMessage({
            contentType: 'text/plain',
            data: reqJson.text
        });
    }
    msg.addMessage({
        contentType: is_html ? 'text/html' : 'text/plain',
        data: content
    });
    const { EmailMessage } = await import('cloudflare:email');
    const message = new EmailMessage(address, to_mail, msg.asRaw());
    await c.env.SEND_MAIL.send(message);
}

export const sendMailByBinding = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: SendMailPayload
): Promise<void> => {
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    await c.env.SEND_MAIL.send({
        from: from_name ? { email: address, name: from_name } : address,
        to: to_name ? [`${to_name} <${to_mail}>`] : [to_mail],
        subject,
        ...(is_html ? { html: content, ...(reqJson.text ? { text: reqJson.text } : {}) } : { text: content }),
    });
}

const sendMailByResend = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: SendMailPayload
): Promise<void> => {
    const mailDomain = getMailDomain(address);
    const token = c.env[
        `RESEND_TOKEN_${mailDomain.replace(/\./g, "_").toUpperCase()}`
    ] || c.env.RESEND_TOKEN;
    const resend = new Resend(token);
    const { data, error } = await resend.emails.send({
        from: reqJson.from_name ? `${reqJson.from_name} <${address}>` : address,
        to: reqJson.to_name ? `${reqJson.to_name} <${reqJson.to_mail}>` : reqJson.to_mail,
        subject: reqJson.subject,
        ...(reqJson.attachments?.length ? {
            attachments: reqJson.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
                contentId: attachment.contentId,
            })),
        } : {}),
        ...(reqJson.is_html ? {
            html: reqJson.content,
            ...(reqJson.text ? { text: reqJson.text } : {}),
        } : {
            text: reqJson.content,
        })
    });
    if (error) {
        throw new Error(`Resend error: ${error.name} ${error.message}`);
    }
    console.log(`Resend success: ${JSON.stringify(data)}`);
}

const sendMailBySmtp = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: SendMailPayload,
    smtpOptions: WorkerMailerOptions
): Promise<void> => {
    await WorkerMailer.send(
        smtpOptions,
        {
            from: {
                name: reqJson.from_name,
                email: address
            },
            to: {
                name: reqJson.to_name,
                email: reqJson.to_mail
            },
            subject: reqJson.subject,
            text: reqJson.is_html ? reqJson.text : reqJson.content,
            html: reqJson.is_html ? reqJson.content : undefined
        }
    )
}

export const sendMail = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: SendMailPayload,
    options?: {
        isAdmin?: boolean
    }
): Promise<void> => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!address) {
        throw new Error(msgs.AddressNotFoundMsg)
    }
    // check domain
    const mailDomain = getMailDomain(address);
    const domains = getDomains(c);
    if (!includesDomain(domains, mailDomain)) {
        throw new Error(msgs.InvalidDomainMsg)
    }
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    if (!to_mail) {
        throw new Error(msgs.InvalidToMailMsg)
    }
    // check SEND_BLOCK_LIST_KEY
    const sendBlockList = await getJsonSetting(c, CONSTANTS.SEND_BLOCK_LIST_KEY) as string[];
    if (sendBlockList && sendBlockList.some((item) => to_mail.includes(item))) {
        throw new Error(msgs.AddressBlockedMsg)
    }
    if (!subject) {
        throw new Error(msgs.SubjectEmptyMsg)
    }
    if (!content) {
        throw new Error(msgs.ContentEmptyMsg)
    }
    // Resolve the transport before reserving quota or balance.
    const resendEnabled = c.env.RESEND_TOKEN || c.env[
        `RESEND_TOKEN_${mailDomain.replace(/\./g, "_").toUpperCase()}`
    ];
    // send by smtp
    const smtpConfigMap = getJsonObjectValue<Record<string, WorkerMailerOptions>>(c.env.SMTP_CONFIG);
    const smtpConfig = getDomainMapValue(smtpConfigMap, mailDomain);
    // send by verified address list
    let sendByVerifiedAddressList = false;
    if (c.env.SEND_MAIL) {
        const verifiedAddressList = await getJsonSetting(c, CONSTANTS.VERIFIED_ADDRESS_LIST_KEY) || [];
        if (verifiedAddressList.includes(to_mail)) {
            sendByVerifiedAddressList = true;
        }
    }
    const sendMailBindingEnabled = isSendMailBindingEnabled(c, mailDomain);
    if (!sendByVerifiedAddressList
        && !resendEnabled
        && !smtpConfig
        && !sendMailBindingEnabled
    ) {
        throw new Error(`${msgs.EnableResendOrSmtpOrSendMailMsg} (${mailDomain})`);
    }

    const sendBalanceState = await getSendBalanceState(c, address, {
        isAdmin: options?.isAdmin,
    });
    const quotaReservation = await reserveSendMailLimit(c);
    let balanceReserved = false;

    try {
        if (!sendByVerifiedAddressList && sendBalanceState.needCheckBalance) {
            balanceReserved = await reserveSendBalance(c, address);
            if (!balanceReserved) throw new Error(msgs.NoBalanceMsg);
        }

        if (sendByVerifiedAddressList) {
            await sendMailToVerifyAddress(c, address, reqJson);
        } else if (resendEnabled) {
            await sendMailByResend(c, address, reqJson);
        } else if (smtpConfig) {
            await sendMailBySmtp(c, address, reqJson, smtpConfig);
        } else {
            await sendMailByBinding(c, address, reqJson);
        }
    } catch (error) {
        const releases: Promise<void>[] = [];
        if (balanceReserved) releases.push(releaseSendBalance(c, address));
        if (quotaReservation) releases.push(releaseSendMailLimit(c, quotaReservation));
        const releaseResults = await Promise.allSettled(releases);
        for (const releaseResult of releaseResults) {
            if (releaseResult.status === 'rejected') {
                console.error('Failed to compensate a send reservation', releaseResult.reason);
            }
        }
        throw error;
    }
    // update address updated_at
    updateAddressUpdatedAt(c, address);
    // save to sendbox
    try {
        const reqIp = c.req.raw.headers.get("cf-connecting-ip")
        const geoData = new GeoData(reqIp, c.req.raw.cf as any);
        const body = {
            version: "v2",
            ...reqJson,
            geoData: geoData,
        };
        const { success: success2 } = await c.env.DB.prepare(
            `INSERT INTO sendbox (address, raw) VALUES (?, ?)`
        ).bind(address, JSON.stringify(body)).run();
        if (!success2) {
            console.warn(`Failed to save to sendbox for ${address}`);
        }
    } catch (e) {
        console.warn(`Failed to save to sendbox for ${address}`);
    }
}

const getPublicSendMailErrorMessage = (
    msgs: ReturnType<typeof i18n.getMessagesbyContext>,
    error: unknown,
): string => {
    const message = error instanceof Error ? error.message : '';
    return Object.values(msgs).includes(message)
        ? message
        : msgs.OperationFailedMsg;
};

const sendMailIdempotently = async (
    c: Context<HonoCustomType>,
    address: string,
    reqJson: SendMailPayload,
    bodyIdempotencyKey?: unknown,
): Promise<'sent' | 'replayed' | 'unavailable'> => {
    const idempotencyKey = resolveOutboundIdempotencyKey(
        c.req.header('idempotency-key'),
        bodyIdempotencyKey,
    );
    c.header('idempotency-key', idempotencyKey);
    const outboundRequest = await beginOutboundSendRequest(
        c.env.DB,
        address,
        idempotencyKey,
        reqJson,
    );
    if (outboundRequest.state === 'completed') {
        return 'replayed';
    }
    if (outboundRequest.state !== 'claimed') {
        return 'unavailable';
    }

    try {
        await sendMail(c, address, reqJson);
    } catch (error) {
        try {
            await failOutboundSendRequest(c.env.DB, outboundRequest);
        } catch (ledgerError) {
            console.error('Failed to record outbound send failure', ledgerError);
        }
        throw error;
    }
    // Do not mark a delivered message as failed when this final ledger write
    // fails: leaving it pending prevents a retry from delivering it twice.
    await completeOutboundSendRequest(c.env.DB, outboundRequest);
    return 'sent';
};

api.post('/api/send_mail', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { address } = c.get("jwtPayload")
    let reqJson: SendMailRequestPayload;
    try {
        reqJson = await c.req.json<SendMailRequestPayload>();
    } catch (error) {
        console.error('Invalid /api/send_mail JSON', error);
        return c.text(msgs.InvalidInputMsg, 400);
    }
    const { idempotency_key: idempotencyKey, token: _token, ...mailPayload } = reqJson;
    try {
        const outcome = await sendMailIdempotently(
            c,
            address,
            mailPayload,
            idempotencyKey,
        );
        if (outcome === 'unavailable') {
            return c.text(msgs.OperationFailedMsg, 409);
        }
    } catch (error) {
        console.error("Failed to send mail", error);
        if (error instanceof InvalidIdempotencyKeyError) {
            return c.text(msgs.InvalidInputMsg, 400);
        }
        return c.text(getPublicSendMailErrorMessage(msgs, error), 400);
    }
    return c.json({ status: "ok" })
})

api.post('/external/api/send_mail', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    let reqJson: SendMailRequestPayload;
    try {
        reqJson = await c.req.json<SendMailRequestPayload>();
    } catch (error) {
        console.error('Invalid /external/api/send_mail JSON', error);
        return c.text(msgs.InvalidInputMsg, 400);
    }
    const {
        token,
        idempotency_key: idempotencyKey,
        ...mailPayload
    } = reqJson;
    if (typeof token !== 'string' || !token) {
        return c.text(msgs.InvalidAddressCredentialMsg, 401);
    }
    let address;
    try {
        const payload = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
        address = await validateAddressTokenAgainstDb(c.env.DB, payload);
        if (!address) {
            return c.text(msgs.InvalidAddressCredentialMsg, 401)
        }
    } catch (error) {
        console.warn('External send-mail credential validation failed', error);
        return c.text(msgs.InvalidAddressCredentialMsg, 401);
    }
    try {
        const outcome = await sendMailIdempotently(
            c,
            address.name,
            mailPayload,
            idempotencyKey,
        );
        if (outcome === 'unavailable') {
            return c.text(msgs.OperationFailedMsg, 409);
        }
        return c.json({ status: "ok" });
    } catch (error) {
        console.error("Failed to send mail", error);
        if (error instanceof InvalidIdempotencyKeyError) {
            return c.text(msgs.InvalidInputMsg, 400);
        }
        return c.text(getPublicSendMailErrorMessage(msgs, error), 400);
    }
})

export const getSendbox = async (
    c: Context<HonoCustomType>,
    address: string, limit: string, offset: string
): Promise<Response> => {
    if (!address) {
        return c.json({ "error": "No address" }, 400)
    }
    return await handleListQuery(c,
        `SELECT * FROM sendbox where address = ? `,
        `SELECT count(*) as count FROM sendbox where address = ? `,
        [address], limit, offset
    );
}

api.get('/api/sendbox', async (c) => {
    const { address } = c.get("jwtPayload")
    const { limit, offset } = c.req.query();
    return getSendbox(c, address, limit, offset);
})

api.delete('/api/sendbox/:id', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address, address_id } = c.get("jwtPayload")
    const { id } = c.req.param();
    const results = await c.env.DB.batch([
        c.env.DB.prepare(
            `DELETE FROM mail_flags WHERE address_id = ? AND mailbox = 'SENT'`
            + ` AND mail_id = ?`
        ).bind(address_id, id),
        c.env.DB.prepare(
            `DELETE FROM sendbox WHERE address = ? AND id = ?`
        ).bind(address, id),
    ]);
    return c.json({
        success: results.every((result) => result.success)
    })
})
