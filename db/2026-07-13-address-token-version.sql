-- Version every address credential so password changes can revoke previously issued JWTs.
-- Existing rows start at version 0, preserving legacy credentials until the first rotation.
ALTER TABLE address ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
