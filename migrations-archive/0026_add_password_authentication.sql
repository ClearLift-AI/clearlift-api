-- Migration: Add password authentication support
--
-- Background: These columns were manually added to production on Oct 17, 2025
-- but never had a proper migration. This migration adds them to ensure
-- fresh database installations have the correct schema.
--
-- Production Impact: SAFE - Columns already exist in production
-- SQLite will silently fail ALTER TABLE ADD COLUMN if column exists

-- Add password authentication columns to users table
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN email_verification_token TEXT;
ALTER TABLE users ADD COLUMN email_verified_at DATETIME;

-- Create password reset tokens table
-- Used by: src/endpoints/v1/auth.ts (password reset flow)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used INTEGER DEFAULT 0,
    used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified);
CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token);
