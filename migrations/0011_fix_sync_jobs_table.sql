-- Migration 0011: Fix sync_jobs table
-- Add missing updated_at column needed by queue consumer

-- Add updated_at column for tracking job updates
ALTER TABLE sync_jobs ADD COLUMN updated_at DATETIME;

-- Create index for efficient queries on updated_at
CREATE INDEX IF NOT EXISTS idx_sync_jobs_updated ON sync_jobs(updated_at);

-- Backfill updated_at with created_at for existing records
UPDATE sync_jobs SET updated_at = created_at WHERE updated_at IS NULL;
