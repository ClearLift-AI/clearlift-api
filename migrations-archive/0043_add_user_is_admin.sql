-- Migration: Add is_admin field to users table
-- Users with @clearlift.ai emails are automatically admins

-- Add is_admin column (default false)
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Set is_admin = 1 for existing users with @clearlift.ai emails
UPDATE users SET is_admin = 1 WHERE email LIKE '%@clearlift.ai';

-- Create index for admin lookups
CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin);
