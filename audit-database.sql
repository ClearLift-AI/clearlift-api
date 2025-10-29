-- ============================================================================
-- D1 Database Audit - Pre-Launch Check
-- ============================================================================

-- 1. USER STATISTICS
SELECT
  'USERS' as category,
  COUNT(*) as total_count,
  COUNT(CASE WHEN email_verified = 1 THEN 1 END) as verified_count,
  COUNT(CASE WHEN email_verified = 0 THEN 1 END) as unverified_count
FROM users;

-- 2. ORGANIZATION STATISTICS
SELECT
  'ORGANIZATIONS' as category,
  COUNT(*) as total_count
FROM organizations;

-- 3. ORGANIZATION MEMBERS
SELECT
  'ORG_MEMBERS' as category,
  COUNT(*) as total_count,
  COUNT(CASE WHEN role = 'owner' THEN 1 END) as owners,
  COUNT(CASE WHEN role = 'admin' THEN 1 END) as admins,
  COUNT(CASE WHEN role = 'member' THEN 1 END) as members,
  COUNT(CASE WHEN role = 'viewer' THEN 1 END) as viewers
FROM organization_members;

-- 4. PLATFORM CONNECTIONS
SELECT
  'CONNECTIONS' as category,
  COUNT(*) as total_count,
  COUNT(CASE WHEN platform = 'stripe' THEN 1 END) as stripe,
  COUNT(CASE WHEN platform = 'google' THEN 1 END) as google,
  COUNT(CASE WHEN platform = 'facebook' THEN 1 END) as facebook,
  COUNT(CASE WHEN is_active = 1 THEN 1 END) as active
FROM platform_connections;

-- 5. SESSIONS
SELECT
  'SESSIONS' as category,
  COUNT(*) as total_count,
  COUNT(CASE WHEN expires_at > datetime('now') THEN 1 END) as active,
  COUNT(CASE WHEN expires_at <= datetime('now') THEN 1 END) as expired
FROM sessions;

-- 6. SYNC JOBS
SELECT
  'SYNC_JOBS' as category,
  COUNT(*) as total_count,
  COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
  COUNT(CASE WHEN status = 'running' THEN 1 END) as running,
  COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
FROM sync_jobs;

-- 7. INVITATIONS
SELECT
  'INVITATIONS' as category,
  COUNT(*) as total_count,
  COUNT(CASE WHEN expires_at > datetime('now') AND accepted_at IS NULL THEN 1 END) as pending,
  COUNT(CASE WHEN accepted_at IS NOT NULL THEN 1 END) as accepted,
  COUNT(CASE WHEN expires_at <= datetime('now') AND accepted_at IS NULL THEN 1 END) as expired
FROM invitations;

-- 8. CONNECTOR CONFIGS
SELECT
  'CONNECTOR_CONFIGS' as category,
  COUNT(*) as total_count,
  COUNT(CASE WHEN is_active = 1 THEN 1 END) as active,
  GROUP_CONCAT(provider) as providers
FROM connector_configs;

-- ============================================================================
-- ORPHANED DATA CHECKS
-- ============================================================================

-- 9. ORPHANED ORGANIZATION MEMBERS (members in non-existent orgs)
SELECT
  'ORPHANED_ORG_MEMBERS' as category,
  COUNT(*) as orphaned_count
FROM organization_members om
WHERE NOT EXISTS (
  SELECT 1 FROM organizations o WHERE o.id = om.organization_id
);

-- 10. ORPHANED PLATFORM CONNECTIONS (connections for non-existent orgs)
SELECT
  'ORPHANED_CONNECTIONS' as category,
  COUNT(*) as orphaned_count
FROM platform_connections pc
WHERE NOT EXISTS (
  SELECT 1 FROM organizations o WHERE o.id = pc.organization_id
);

-- 11. ORPHANED SYNC JOBS (jobs for non-existent connections)
SELECT
  'ORPHANED_SYNC_JOBS' as category,
  COUNT(*) as orphaned_count
FROM sync_jobs sj
WHERE NOT EXISTS (
  SELECT 1 FROM platform_connections pc WHERE pc.id = sj.connection_id
);

-- 12. ORPHANED SESSIONS (sessions for non-existent users)
SELECT
  'ORPHANED_SESSIONS' as category,
  COUNT(*) as orphaned_count
FROM sessions s
WHERE NOT EXISTS (
  SELECT 1 FROM users u WHERE u.id = s.user_id
);

-- 13. ORPHANED INVITATIONS (invitations for non-existent orgs)
SELECT
  'ORPHANED_INVITATIONS' as category,
  COUNT(*) as orphaned_count
FROM invitations i
WHERE NOT EXISTS (
  SELECT 1 FROM organizations o WHERE o.id = i.organization_id
);

-- ============================================================================
-- DATA INTEGRITY CHECKS
-- ============================================================================

-- 14. USERS WITHOUT ORGANIZATIONS
SELECT
  'USERS_NO_ORG' as category,
  COUNT(*) as count
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM organization_members om WHERE om.user_id = u.id
);

-- 15. ORGANIZATIONS WITHOUT MEMBERS
SELECT
  'ORGS_NO_MEMBERS' as category,
  COUNT(*) as count
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM organization_members om WHERE om.organization_id = o.id
);

-- 16. CONNECTIONS WITHOUT RECENT SYNC
SELECT
  'CONNECTIONS_NO_RECENT_SYNC' as category,
  COUNT(*) as count
FROM platform_connections
WHERE is_active = 1
  AND (last_synced_at IS NULL OR last_synced_at < datetime('now', '-7 days'));
