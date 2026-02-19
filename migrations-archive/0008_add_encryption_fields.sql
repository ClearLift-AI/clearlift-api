-- Migration number: 0008 2025-10-10T00:00:00.000Z
-- Add encrypted field support for sensitive PII

-- Add encrypted email fields to users table
ALTER TABLE users ADD COLUMN email_encrypted TEXT;
ALTER TABLE users ADD COLUMN email_hash TEXT;

-- Add encrypted IP address field to sessions
ALTER TABLE sessions ADD COLUMN ip_address_encrypted TEXT;

-- Add encrypted settings to platform_connections (for OAuth tokens)
ALTER TABLE platform_connections ADD COLUMN settings_encrypted TEXT;

-- Add encrypted email to invitations
ALTER TABLE invitations ADD COLUMN email_encrypted TEXT;
ALTER TABLE invitations ADD COLUMN email_hash TEXT;

-- Create indexes for hash-based lookups
CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_email_hash ON invitations(email_hash);

-- Note: After migration, run a one-time script to:
-- 1. Encrypt existing plaintext values
-- 2. Populate _encrypted and _hash columns
-- 3. Optionally remove plaintext columns (or null them out)
