import { Context } from "hono";

import { getBooleanValue, getJsonSetting, normalizeAddressDomain } from "../utils";
import { sendMailToTelegram } from "../telegram_api";
import { auto_reply } from "./auto_reply";
import { isBlocked } from "./black_list";
import { triggerWebhook, triggerAnotherWorker, commonParseMail } from "../common";
import { check_if_junk_mail } from "./check_junk";
import { remove_attachment_if_need } from "./check_attachment";
import { extractEmailInfo } from "./ai_extract";
import { forwardEmail } from "./forward";
import { EmailRuleSettings } from "../models";
import { CONSTANTS } from "../constants";
import { compressText } from "../gzip";
import {
    buildInboundDeliveryKey,
    temporaryDeliveryFailure,
} from './delivery_failure';

type StoredMailColumn = 'raw' | 'raw_blob';

const storeInboundMail = async (
    env: Bindings,
    message: ForwardableEmailMessage,
    recipient: string,
    messageId: string | null,
    deliveryKey: string | null,
    column: StoredMailColumn,
    content: string | ArrayBuffer,
): Promise<'stored' | 'duplicate'> => {
    const result = await env.DB.prepare(
        `INSERT INTO raw_mails (source, address, ${column}, message_id, delivery_key)`
        + ` VALUES (?, ?, ?, ?, ?)`
        + ` ON CONFLICT(delivery_key) WHERE delivery_key IS NOT NULL DO NOTHING`
    ).bind(
        message.from,
        recipient,
        content,
        messageId,
        deliveryKey,
    ).run();
    if (!result.success) throw new Error('D1 did not persist the inbound email');
    if (result.meta.changes === 1) return 'stored';
    if (deliveryKey && result.meta.changes === 0) return 'duplicate';
    throw new Error('D1 did not persist the inbound email');
};


async function email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext) {
    const toAddress = normalizeAddressDomain(message.to);
    if (await isBlocked(message.from, env)) {
        message.setReject("Reject from address");
        console.log(`Reject message from ${message.from} to ${toAddress}`);
        return;
    }
    const rawEmail = await new Response(message.raw).text();
    const parsedEmailContext: ParsedEmailContext = {
        rawEmail: rawEmail
    };

    // check if junk mail
    try {
        const is_junk = await check_if_junk_mail(env, toAddress, parsedEmailContext, message.headers.get("Message-ID"));
        if (is_junk) {
            message.setReject("Junk mail");
            console.log(`Junk mail from ${message.from} to ${toAddress}`);
            return;
        }
    } catch (error) {
        console.error("check junk mail error", error);
    }

    // check if unknown address mail
    try {
        const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
            { env: env } as Context<HonoCustomType>, CONSTANTS.EMAIL_RULE_SETTINGS_KEY
        );
        if (emailRuleSettings?.blockReceiveUnknowAddressEmail) {
            const db_address_id = await env.DB.prepare(
                `SELECT id FROM address where name = ? `
            ).bind(toAddress).first("id");
            if (!db_address_id) {
                message.setReject("Unknown address");
                console.log(`Unknown address mail from ${message.from} to ${toAddress}`);
                return;
            }
        }
    } catch (error) {
        console.error("check unknown address mail error", error);
    }

    // remove attachment if configured or size > 2MB
    try {
        await remove_attachment_if_need(env, parsedEmailContext, message.from, toAddress, message.rawSize);
    } catch (error) {
        console.error("remove attachment error", error);
    }

    const message_id = message.headers.get("Message-ID");
    // save email
    try {
        const deliveryKey = await buildInboundDeliveryKey(
            toAddress,
            message.from,
            message_id,
        );
        let storageOutcome: 'stored' | 'duplicate';
        if (getBooleanValue(env.ENABLE_MAIL_GZIP)) {
            let compressed: ArrayBuffer | null = null;
            try {
                compressed = await compressText(parsedEmailContext.rawEmail);
            } catch (gzipError) {
                console.error("gzip compression failed, falling back to plaintext", gzipError);
            }
            if (compressed) {
                try {
                    storageOutcome = await storeInboundMail(
                        env, message, toAddress, message_id, deliveryKey,
                        'raw_blob', compressed,
                    );
                } catch (dbError) {
                    // Fallback to plaintext only if raw_blob column is missing (migration not applied)
                    const errMsg = String(dbError);
                    if (errMsg.includes('raw_blob') || errMsg.includes('no such column')) {
                        console.error("raw_blob column missing, falling back to plaintext", dbError);
                        storageOutcome = await storeInboundMail(
                            env, message, toAddress, message_id, deliveryKey,
                            'raw', parsedEmailContext.rawEmail,
                        );
                    } else {
                        throw dbError;
                    }
                }
            } else {
                storageOutcome = await storeInboundMail(
                    env, message, toAddress, message_id, deliveryKey,
                    'raw', parsedEmailContext.rawEmail,
                );
            }
        } else {
            storageOutcome = await storeInboundMail(
                env, message, toAddress, message_id, deliveryKey,
                'raw', parsedEmailContext.rawEmail,
            );
        }
        const isDuplicate = storageOutcome === 'duplicate';
        if (isDuplicate) {
            console.log(`Skip duplicate inbound email ${message_id} for ${toAddress}`);
            return;
        }
    } catch (error) {
        temporaryDeliveryFailure(toAddress, error);
    }

    // forward email
    try {
        await forwardEmail(message, env);
    } catch (error) {
        console.error('forward email error', error);
    }

    // AI email content extraction
    let aiExtractResult: Awaited<ReturnType<typeof extractEmailInfo>> = null;
    try {
        aiExtractResult = await extractEmailInfo(
            parsedEmailContext,
            env,
            message_id,
            toAddress,
        );
    } catch (error) {
        console.error('extract email info error', error);
    }

    // send email to telegram
    try {
        await sendMailToTelegram(
            { env: env } as Context<HonoCustomType>,
            toAddress, parsedEmailContext, message_id, aiExtractResult);
    } catch (error) {
        console.error("send mail to telegram error", error);
    }

    // send webhook
    try {
        await triggerWebhook(
            { env: env } as Context<HonoCustomType>,
            toAddress, parsedEmailContext, message_id, aiExtractResult
        );
    } catch (error) {
        console.error("send webhook error", error);
    }

    // trigger another worker
    try {
        const parsedEmail = (await commonParseMail(parsedEmailContext));
        const parsedText = parsedEmail?.text ?? ""
        const rpcEmail: RPCEmailMessage = {
            from: message.from,
            to: toAddress,
            rawEmail: rawEmail,
            headers: message.headers
        }
        await triggerAnotherWorker({ env: env } as Context<HonoCustomType>, rpcEmail, parsedText);
    } catch (error) {
        console.error("trigger another worker error", error);
    }

    // auto reply email
    try {
        await auto_reply(message, env, toAddress);
    } catch (error) {
        console.error('auto reply email error', error);
    }
}

export { email }
