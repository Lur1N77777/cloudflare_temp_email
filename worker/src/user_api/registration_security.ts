const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const VERIFICATION_CODE_SPACE = 1_000_000;
const UINT32_SPACE = 0x1_0000_0000;
const MAX_UNBIASED_UINT32 = Math.floor(UINT32_SPACE / VERIFICATION_CODE_SPACE)
    * VERIFICATION_CODE_SPACE;
export const MAX_REGISTRATION_ATTEMPTS = 5;

export const normalizeUserEmail = (input: unknown): string => {
    if (typeof input !== 'string') throw new Error('Invalid email');
    const email = input.trim().toLowerCase();
    const [localPart, domain, extra] = email.split('@');
    if (extra !== undefined
        || !EMAIL_PATTERN.test(email)
        || email.length > MAX_EMAIL_LENGTH
        || !localPart
        || localPart.length > MAX_LOCAL_PART_LENGTH
        || !domain
    ) throw new Error('Invalid email');
    return email;
};

export const generateRegistrationCode = (): string => {
    const randomValue = new Uint32Array(1);
    do {
        crypto.getRandomValues(randomValue);
    } while (randomValue[0] >= MAX_UNBIASED_UINT32);
    return (randomValue[0] % VERIFICATION_CODE_SPACE).toString().padStart(6, '0');
};

export const REGISTRATION_CHALLENGE_RESERVE_SQL = `
    INSERT INTO registration_challenges (email, code, expires_at, consumed_at, attempts)
    SELECT ?, ?, unixepoch() + ?, NULL, 0
    WHERE NOT EXISTS (
        SELECT 1 FROM users WHERE user_email = ? COLLATE NOCASE
    )
    ON CONFLICT(email) DO UPDATE SET
        code = excluded.code,
        expires_at = excluded.expires_at,
        consumed_at = NULL,
        attempts = 0,
        created_at = CURRENT_TIMESTAMP
    WHERE registration_challenges.expires_at <= unixepoch()
       OR registration_challenges.consumed_at IS NOT NULL
`;

export const REGISTRATION_CHALLENGE_FAILURE_SQL = `
    UPDATE registration_challenges SET
        attempts = attempts + 1,
        consumed_at = CASE
            WHEN attempts + 1 >= ?1 THEN unixepoch()
            ELSE consumed_at
        END
    WHERE email = ?2 COLLATE NOCASE
      AND code <> ?3
      AND expires_at > unixepoch()
      AND consumed_at IS NULL
      AND attempts < ?1
    RETURNING attempts, consumed_at
`;
