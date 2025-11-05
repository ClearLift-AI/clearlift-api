-- Migration 0020: Make organization_id and user_id nullable in audit_logs
-- This allows logging of:
-- 1. User-scoped operations (e.g., /v1/user/organizations) without org context
-- 2. Unauthenticated requests (e.g., health checks, login attempts) without user context
--
-- The audit middleware runs globally before route-specific auth middleware,
-- so it needs to handle cases where session/user info isn't available yet.

-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table

-- 1. Create new table with nullable organization_id and user_id
CREATE TABLE audit_logs_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT,  -- Now nullable (was NOT NULL)
    user_id TEXT,  -- Now nullable (was NOT NULL)
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    metadata TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_token_hash TEXT,
    method TEXT,
    path TEXT,
    user_agent TEXT,
    request_id TEXT,
    success INTEGER DEFAULT 1,
    status_code INTEGER,
    error_code TEXT,
    error_message TEXT,
    response_time_ms INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Copy existing data from old table
INSERT INTO audit_logs_new
SELECT * FROM audit_logs;

-- 3. Drop old table
DROP TABLE audit_logs;

-- 4. Rename new table to original name
ALTER TABLE audit_logs_new RENAME TO audit_logs;

-- 5. Recreate indexes for performance
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
