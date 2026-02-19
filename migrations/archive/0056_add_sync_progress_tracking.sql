-- Add progress tracking columns to sync_jobs
-- Enables real-time progress feedback in the UI

ALTER TABLE sync_jobs ADD COLUMN current_phase TEXT;
ALTER TABLE sync_jobs ADD COLUMN total_records INTEGER;
ALTER TABLE sync_jobs ADD COLUMN progress_percentage INTEGER DEFAULT 0;

-- Index for faster lookups by connection
CREATE INDEX IF NOT EXISTS idx_sync_jobs_connection_status ON sync_jobs(connection_id, status);
