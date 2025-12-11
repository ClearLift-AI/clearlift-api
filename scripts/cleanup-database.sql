-- Cleanup script for ClearLift database
-- Run this via wrangler d1 execute

-- 1. Delete old OAuth states (older than 1 hour)
DELETE FROM oauth_states
WHERE created_at < datetime('now', '-1 hour');

-- 2. Delete orphaned sync jobs (jobs without valid connections)
DELETE FROM sync_jobs
WHERE connection_id NOT IN (SELECT id FROM platform_connections);

-- 3. Show remaining OAuth states (for review)
SELECT
  provider,
  created_at,
  datetime('now') as now,
  ROUND((julianday('now') - julianday(created_at)) * 24 * 60, 2) as age_minutes
FROM oauth_states
ORDER BY created_at DESC;

-- 4. Show all connections with their sync status
SELECT
  id,
  platform,
  account_name,
  sync_status,
  last_synced_at,
  created_at,
  is_active
FROM platform_connections
ORDER BY created_at DESC;
