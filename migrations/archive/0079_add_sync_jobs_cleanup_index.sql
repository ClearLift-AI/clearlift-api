-- Add composite index for sync_jobs cleanup queries
-- Supports: DELETE WHERE status IN (...) AND created_at < datetime(...)
-- Also speeds up admin dashboard queries that filter by status
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_created
  ON sync_jobs(status, created_at);
