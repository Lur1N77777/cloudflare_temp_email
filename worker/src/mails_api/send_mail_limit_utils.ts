import { Context } from "hono";
import i18n from "../i18n";
import { SendMailLimitConfig } from "../models";
import { CONSTANTS } from "../constants";
import { getJsonObjectValue, getSetting } from "../utils";
import {
    SEND_MAIL_QUOTA_RELEASE_SQL,
    SEND_MAIL_QUOTA_RESERVE_SQL,
} from './send_reservation_sql';

class SendMailLimitError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const parseLimitValue = (value: unknown): number | null => {
    if (value === null || typeof value === "undefined") {
        return null;
    }
    if (!Number.isInteger(value) || (value as number) < -1) {
        return null;
    }
    return value as number;
}

const isValidLimitValue = (value: number | null): boolean => {
    return value === -1 || (value !== null && value >= 0);
}

const parseSendMailLimitConfig = (value: unknown): SendMailLimitConfig | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const config = value as Record<string, unknown>;
    if (typeof config.dailyEnabled !== "boolean" || typeof config.monthlyEnabled !== "boolean") {
        return null;
    }
    const dailyLimit = parseLimitValue(config.dailyLimit);
    const monthlyLimit = parseLimitValue(config.monthlyLimit);
    const monthlyValid = config.monthlyEnabled
        ? isValidLimitValue(monthlyLimit)
        : (config.monthlyLimit === null || typeof config.monthlyLimit === "undefined" || monthlyLimit !== null);
    const dailyValid = config.dailyEnabled
        ? isValidLimitValue(dailyLimit)
        : (config.dailyLimit === null || typeof config.dailyLimit === "undefined" || dailyLimit !== null);
    if (!dailyValid || !monthlyValid) {
        return null;
    }
    return {
        dailyEnabled: config.dailyEnabled,
        monthlyEnabled: config.monthlyEnabled,
        dailyLimit,
        monthlyLimit,
    };
}

export const validateSendMailLimitConfig = (value: unknown): boolean => {
    return !!parseSendMailLimitConfig(value);
}

export const getSendMailLimitConfigToSave = (
    value: unknown
): SendMailLimitConfig | null => {
    const sendMailLimitConfig = parseSendMailLimitConfig(value);
    if (!sendMailLimitConfig) {
        return null;
    }
    return {
        dailyEnabled: sendMailLimitConfig.dailyEnabled,
        monthlyEnabled: sendMailLimitConfig.monthlyEnabled,
        dailyLimit: sendMailLimitConfig.dailyEnabled ? sendMailLimitConfig.dailyLimit : null,
        monthlyLimit: sendMailLimitConfig.monthlyEnabled ? sendMailLimitConfig.monthlyLimit : null,
    };
}

export const getSendMailLimitConfig = async (
    c: Context<HonoCustomType>
): Promise<SendMailLimitConfig | null> => {
    return getSendMailLimitConfigToSave(getJsonObjectValue<SendMailLimitConfig>(
        await getSetting(c, CONSTANTS.SEND_MAIL_LIMIT_CONFIG_KEY)
    ));
}

const getDailyCountKey = (date: Date = new Date()): string => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `${CONSTANTS.SEND_MAIL_LIMIT_COUNT_KEY_PREFIX}daily:${yyyy}-${mm}-${dd}`;
}

const getMonthlyCountKey = (date: Date = new Date()): string => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${CONSTANTS.SEND_MAIL_LIMIT_COUNT_KEY_PREFIX}monthly:${yyyy}-${mm}`;
}

export type SendMailLimitReservation = {
    dailyPeriod: string;
    monthlyPeriod: string;
    dailyReserved: boolean;
    monthlyReserved: boolean;
};

const getPeriodFromCounterKey = (key: string): string => key.slice(key.lastIndexOf(':') + 1);

export const reserveSendMailLimit = async (
    c: Context<HonoCustomType>
): Promise<SendMailLimitReservation | null> => {
    const config = await getSendMailLimitConfig(c);
    if (!config) return null;
    const dailyReserved = config.dailyEnabled
        && config.dailyLimit !== null
        && config.dailyLimit !== -1;
    const monthlyReserved = config.monthlyEnabled
        && config.monthlyLimit !== null
        && config.monthlyLimit !== -1;
    if (!dailyReserved && !monthlyReserved) return null;

    const dailyPeriod = getPeriodFromCounterKey(getDailyCountKey());
    const monthlyPeriod = getPeriodFromCounterKey(getMonthlyCountKey());
    const dailyLimit = dailyReserved ? config.dailyLimit as number : -1;
    const monthlyLimit = monthlyReserved ? config.monthlyLimit as number : -1;
    const dailyFlag = dailyReserved ? 1 : 0;
    const monthlyFlag = monthlyReserved ? 1 : 0;
    const result = await c.env.DB.prepare(SEND_MAIL_QUOTA_RESERVE_SQL).bind(
        dailyPeriod,
        dailyFlag,
        monthlyPeriod,
        monthlyFlag,
        dailyFlag,
        dailyLimit,
        monthlyFlag,
        monthlyLimit,
        dailyFlag,
        monthlyFlag,
        dailyFlag,
        dailyLimit,
        monthlyFlag,
        monthlyLimit,
    ).run();
    if (result.success && result.meta.changes === 1) {
        return { dailyPeriod, monthlyPeriod, dailyReserved, monthlyReserved };
    }

    const state = await c.env.DB.prepare(
        `SELECT daily_period, daily_count, monthly_period, monthly_count`
        + ` FROM send_mail_quota_state WHERE singleton = 1`
    ).first<{
        daily_period: string;
        daily_count: number;
        monthly_period: string;
        monthly_count: number;
    }>();
    const msgs = i18n.getMessagesbyContext(c);
    const currentDailyCount = state?.daily_period === dailyPeriod ? state.daily_count : 0;
    if (dailyReserved && currentDailyCount >= dailyLimit) {
        throw new SendMailLimitError(msgs.ServerSendMailDailyLimitMsg);
    }
    throw new SendMailLimitError(msgs.ServerSendMailMonthlyLimitMsg);
};

export const releaseSendMailLimit = async (
    c: Context<HonoCustomType>,
    reservation: SendMailLimitReservation,
): Promise<void> => {
    const dailyFlag = reservation.dailyReserved ? 1 : 0;
    const monthlyFlag = reservation.monthlyReserved ? 1 : 0;
    const result = await c.env.DB.prepare(SEND_MAIL_QUOTA_RELEASE_SQL).bind(
        reservation.dailyPeriod,
        dailyFlag,
        reservation.monthlyPeriod,
        monthlyFlag,
        reservation.dailyPeriod,
        dailyFlag,
        reservation.monthlyPeriod,
        monthlyFlag,
    ).run();
    if (!result.success || result.meta.changes !== 1) {
        console.error('Failed to release reserved send-mail quota');
    }
};
