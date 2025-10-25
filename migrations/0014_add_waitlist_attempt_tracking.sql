-- Migration: Add attempt tracking to waitlist
-- Created: 2025-10-24
-- Description: Track how many times someone tries to join (shows high interest!)

-- Add attempt counter and last attempt timestamp
ALTER TABLE waitlist ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE waitlist ADD COLUMN last_attempt_at TEXT;

-- Initialize last_attempt_at with created_at for existing records
UPDATE waitlist SET last_attempt_at = created_at WHERE last_attempt_at IS NULL;

-- Create index for finding highly interested users
CREATE INDEX IF NOT EXISTS idx_waitlist_attempt_count ON waitlist(attempt_count DESC);
