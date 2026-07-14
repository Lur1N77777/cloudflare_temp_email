import { Context } from "hono";
import { isSendMailBindingEnabled } from "../common";
import i18n from "../i18n";
import { sendMail } from "../mails_api/send_mail_api";
import { releaseSendMailLimit, reserveSendMailLimit } from "../mails_api/send_mail_limit_utils";
import {
    InvalidIdempotencyKeyError,
    type OutboundSendRequest,
    beginOutboundSendRequest,
    completeOutboundSendRequest,
    failOutboundSendRequest,
    resolveOutboundIdempotencyKey,
} from "../mails_api/outbound_idempotency";
import { getMailDomain } from "../utils";

const getAdminSendMailErrorMessage = (
    msgs: ReturnType<typeof i18n.getMessagesbyContext>,
    error: unknown
): string => {
    const message = error instanceof Error ? error.message : "";
    return Object.values(msgs).includes(message)
        ? message
        : msgs.OperationFailedMsg;
}

const recordAdminSendFailure = async (
    c: Context<HonoCustomType>,
    request: OutboundSendRequest,
): Promise<void> => {
    try {
        await failOutboundSendRequest(c.env.DB, request);
    } catch (ledgerError) {
        console.error('Failed to record admin outbound send failure', ledgerError);
    }
};

export const sendMailbyAdmin = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    let reqJson;
    try {
        reqJson = await c.req.json();
    } catch (e) {
        console.error("Admin send_mail invalid json", e);
        return c.text(msgs.InvalidInputMsg, 400)
    }
    const {
        from_name, from_mail,
        to_mail, to_name,
        subject, content, is_html,
        idempotency_key: bodyIdempotencyKey,
    } = reqJson;
    if (typeof from_mail !== 'string' || !from_mail.trim()) {
        return c.text(msgs.InvalidInputMsg, 400);
    }
    const outboundPayload = {
        from_name,
        from_mail,
        to_mail,
        to_name,
        subject,
        content,
        is_html,
    };
    let outboundRequest: OutboundSendRequest;
    try {
        const idempotencyKey = resolveOutboundIdempotencyKey(
            c.req.header('idempotency-key'),
            bodyIdempotencyKey,
        );
        c.header('idempotency-key', idempotencyKey);
        outboundRequest = await beginOutboundSendRequest(
            c.env.DB,
            from_mail,
            idempotencyKey,
            outboundPayload,
        );
    } catch (error) {
        console.error('Admin send_mail idempotency claim failed', error);
        return c.text(
            error instanceof InvalidIdempotencyKeyError
                ? msgs.InvalidInputMsg
                : msgs.OperationFailedMsg,
            400,
        );
    }
    if (outboundRequest.state === 'completed') {
        return c.json({ status: "ok" });
    }
    if (outboundRequest.state !== 'claimed') {
        return c.text(msgs.OperationFailedMsg, 409);
    }
    try {
        await sendMail(c, from_mail, {
            from_name: from_name,
            to_name: to_name,
            to_mail: to_mail,
            subject: subject,
            content: content,
            is_html: is_html,
        }, {
            isAdmin: true
        })
    } catch (error) {
        await recordAdminSendFailure(c, outboundRequest);
        console.error("Admin send_mail failed", error);
        return c.text(getAdminSendMailErrorMessage(msgs, error), 400)
    }
    try {
        // A completion-write failure must stay pending because delivery has
        // already happened and retrying could create a duplicate message.
        await completeOutboundSendRequest(c.env.DB, outboundRequest);
    } catch (error) {
        console.error('Admin send_mail completion recording failed', error);
        return c.text(msgs.OperationFailedMsg, 400);
    }
    return c.json({ status: "ok" });
}

export const sendMailByBindingAdmin = async (c: Context<HonoCustomType>) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!c.env.SEND_MAIL) {
        return c.text(msgs.EnableSendMailMsg, 400)
    }
    let reqJson;
    try {
        reqJson = await c.req.json();
    } catch (e) {
        console.error("Admin raw send_mail invalid json", e);
        return c.text(msgs.InvalidInputMsg, 400)
    }
    const {
        from, to, subject,
        html, text,
        cc, bcc, replyTo,
        attachments, headers,
        idempotency_key: bodyIdempotencyKey,
    } = reqJson;
    if (!from || !to || !subject || (!html && !text)) {
        return c.text(msgs.InvalidInputMsg, 400)
    }
    const fromMail = typeof from === "string" ? from : from?.email;
    const mailDomain = getMailDomain(fromMail);
    if (!mailDomain) {
        return c.text(msgs.InvalidInputMsg, 400)
    }
    if (!isSendMailBindingEnabled(c, mailDomain)) {
        return c.text(msgs.EnableSendMailForDomainMsg, 400)
    }
    const outboundPayload = {
        from,
        to,
        subject,
        html,
        text,
        cc,
        bcc,
        replyTo,
        attachments,
        headers,
    };
    let outboundRequest: OutboundSendRequest;
    try {
        const idempotencyKey = resolveOutboundIdempotencyKey(
            c.req.header('idempotency-key'),
            bodyIdempotencyKey,
        );
        c.header('idempotency-key', idempotencyKey);
        outboundRequest = await beginOutboundSendRequest(
            c.env.DB,
            fromMail,
            idempotencyKey,
            outboundPayload,
        );
    } catch (error) {
        console.error('Admin raw send_mail idempotency claim failed', error);
        return c.text(
            error instanceof InvalidIdempotencyKeyError
                ? msgs.InvalidInputMsg
                : msgs.OperationFailedMsg,
            400,
        );
    }
    if (outboundRequest.state === 'completed') {
        return c.json({ status: "ok" });
    }
    if (outboundRequest.state !== 'claimed') {
        return c.text(msgs.OperationFailedMsg, 409);
    }
    let quotaReservation: Awaited<ReturnType<typeof reserveSendMailLimit>> = null;
    try {
        quotaReservation = await reserveSendMailLimit(c);
        await c.env.SEND_MAIL.send({
            from,
            to,
            subject,
            ...(html ? { html } : {}),
            ...(text ? { text } : {}),
            ...(cc ? { cc } : {}),
            ...(bcc ? { bcc } : {}),
            ...(replyTo ? { replyTo } : {}),
            ...(attachments && attachments.length ? { attachments } : {}),
            ...(headers ? { headers } : {}),
        });
    } catch (e) {
        if (quotaReservation) {
            try {
                await releaseSendMailLimit(c, quotaReservation);
            } catch (releaseError) {
                console.error('Failed to compensate admin send quota', releaseError);
            }
        }
        await recordAdminSendFailure(c, outboundRequest);
        console.error("Admin raw send_mail failed", e);
        return c.text(getAdminSendMailErrorMessage(msgs, e), 400)
    }
    try {
        await completeOutboundSendRequest(c.env.DB, outboundRequest);
    } catch (error) {
        console.error('Admin raw send_mail completion recording failed', error);
        return c.text(msgs.OperationFailedMsg, 400);
    }
    return c.json({ status: "ok" });
}
