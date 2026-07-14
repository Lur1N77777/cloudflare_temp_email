export const SEND_BALANCE_RESERVE_SQL = `
    UPDATE address_sender
    SET balance = balance - 1
    WHERE address = ? AND enabled = 1 AND balance > 0
`;

export const SEND_BALANCE_RELEASE_SQL = `
    UPDATE address_sender
    SET balance = balance + 1
    WHERE address = ?
`;

export const SEND_MAIL_QUOTA_RESERVE_SQL = `
    INSERT INTO send_mail_quota_state (
        singleton,
        daily_period,
        daily_count,
        monthly_period,
        monthly_count,
        updated_at
    )
    SELECT 1, ?, ?, ?, ?, CURRENT_TIMESTAMP
    WHERE (? = 0 OR ? > 0)
      AND (? = 0 OR ? > 0)
    ON CONFLICT(singleton) DO UPDATE SET
        daily_period = excluded.daily_period,
        daily_count = CASE
            WHEN send_mail_quota_state.daily_period = excluded.daily_period
                THEN send_mail_quota_state.daily_count + ?
            ELSE excluded.daily_count
        END,
        monthly_period = excluded.monthly_period,
        monthly_count = CASE
            WHEN send_mail_quota_state.monthly_period = excluded.monthly_period
                THEN send_mail_quota_state.monthly_count + ?
            ELSE excluded.monthly_count
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE (? = 0 OR (
        CASE
            WHEN send_mail_quota_state.daily_period = excluded.daily_period
                THEN send_mail_quota_state.daily_count
            ELSE 0
        END
    ) < ?)
      AND (? = 0 OR (
        CASE
            WHEN send_mail_quota_state.monthly_period = excluded.monthly_period
                THEN send_mail_quota_state.monthly_count
            ELSE 0
        END
    ) < ?)
`;

export const SEND_MAIL_QUOTA_RELEASE_SQL = `
    UPDATE send_mail_quota_state SET
        daily_count = CASE
            WHEN daily_period = ? THEN MAX(daily_count - ?, 0)
            ELSE daily_count
        END,
        monthly_count = CASE
            WHEN monthly_period = ? THEN MAX(monthly_count - ?, 0)
            ELSE monthly_count
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE (daily_period = ? AND ? > 0 AND daily_count > 0)
       OR (monthly_period = ? AND ? > 0 AND monthly_count > 0)
`;
