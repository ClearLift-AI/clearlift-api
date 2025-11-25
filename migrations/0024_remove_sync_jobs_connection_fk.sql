-- Migration: Remove foreign key constraint on sync_jobs.connection_id
--
-- Reason: Event syncs don't use OAuth connections (they sync from R2 Data Catalog)
--         and use synthetic connection_id values like 'events-{org_tag}' that don't
--         exist in platform_connections table. The foreign key constraint was causing
--         event sync scheduling to fail.
--
-- Changes:
--   - Remove FOREIGN KEY constraint on connection_id
--   - Keep organization_id FOREIGN KEY (still valid for all sync types)

-- 1. Create new table without connection_id foreign key
CREATE TABLE sync_jobs_new (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    job_type TEXT DEFAULT 'full',
    started_at DATETIME,
    completed_at DATETIME,
    error_message TEXT,
    records_synced INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT DEFAULT '{}',
    updated_at DATETIME,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- 2. Copy existing data (sync_jobs didn't have updated_at column originally)
INSERT INTO sync_jobs_new (id, organization_id, connection_id, status, job_type, started_at, completed_at, error_message, records_synced, created_at, metadata, updated_at)
SELECT
    id,
    organization_id,
    connection_id,
    status,
    job_type,
    started_at,
    completed_at,
    error_message,
    records_synced,
    created_at,
    metadata,
    NULL
FROM sync_jobs;

-- 3. Drop old table
DROP TABLE sync_jobs;

-- 4. Rename new table
ALTER TABLE sync_jobs_new RENAME TO sync_jobs;

-- 5. Recreate indexes (if any existed)
-- (None defined in original schema)
