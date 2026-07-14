-- Version user credentials so administrator password resets immediately revoke
-- every previously issued user session. Existing sessions remain compatible at
-- version zero until the first reset.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
