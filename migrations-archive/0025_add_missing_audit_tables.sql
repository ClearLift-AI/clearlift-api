-- Migration 0025: Add Missing Audit Tables (Retroactive for Fresh Databases)
--
-- CONTEXT: The original 0011_add_audit_logs.sql (created Oct 16, 2025) was deleted
-- on Oct 22, 2025 and replaced with 0011_complete_audit_system.sql which only
-- contained ALTER TABLE statements. This caused fresh database installations to fail
-- because the base audit_logs table was never created.
--
-- This migration is IDEMPOTENT and PRODUCTION-SAFE:
-- - For production databases: This is a no-op (tables already exist)
-- - For fresh databases: This creates all audit tables with their final structure
--
-- The structure here matches the FINAL state after migrations 0011, 0020, and 0021
-- have run (nullable user_id/organization_id, no foreign keys, all audit fields).

-- =============================================================================
-- 1. MAIN AUDIT LOGS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- User context (nullable as per migrations 0020/0021)
  user_id TEXT,
  organization_id TEXT,
  session_token_hash TEXT,

  -- Request details
  action TEXT NOT NULL,
  method TEXT,
  path TEXT,
  resource_type TEXT,
  resource_id TEXT,

  -- Network details
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,

  -- Result tracking
  success INTEGER DEFAULT 1,
  status_code INTEGER,
  error_code TEXT,
  error_message TEXT,

  -- Performance
  response_time_ms INTEGER,

  -- Additional context (JSON)
  metadata TEXT

  -- Note: No foreign keys - removed by migrations 0020/0021 due to SQLite limitations
);

-- =============================================================================
-- 2. AUTHENTICATION AUDIT LOGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- Event identification
  event_type TEXT NOT NULL, -- login|logout|session_refresh|oauth_connect|failed_login
  user_id TEXT,
  email TEXT,

  -- Authentication method
  auth_method TEXT, -- password|oauth|api_key
  provider TEXT, -- google|facebook|stripe|etc

  -- Network context
  ip_address TEXT,
  user_agent TEXT,

  -- Result tracking
  success INTEGER DEFAULT 1,
  failure_reason TEXT,

  -- Session tracking
  session_id TEXT,
  session_created INTEGER DEFAULT 0,

  -- Additional context
  metadata TEXT
);

-- =============================================================================
-- 3. DATA ACCESS LOGS (SOC 2 Compliance)
-- =============================================================================

CREATE TABLE IF NOT EXISTS data_access_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- Access context
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  access_type TEXT NOT NULL, -- query|export|report|api_fetch

  -- Data source tracking
  data_source TEXT NOT NULL, -- r2_sql|supabase|d1|external_api
  table_name TEXT,
  query_hash TEXT, -- SHA-256 hash of query for pattern detection
  filters_applied TEXT,

  -- Access scope
  records_accessed INTEGER,
  fields_accessed TEXT,
  query_time_ms INTEGER,

  -- Export tracking
  export_format TEXT, -- csv|json|pdf
  export_destination TEXT,

  -- Data classification
  contains_pii INTEGER DEFAULT 0,
  data_classification TEXT DEFAULT 'internal', -- public|internal|confidential|restricted

  -- Request tracking
  request_id TEXT,
  ip_address TEXT
);

-- =============================================================================
-- 4. CONFIGURATION AUDIT LOGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS config_audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- Change context
  user_id TEXT NOT NULL,
  organization_id TEXT,
  config_type TEXT NOT NULL, -- connector|user|organization|system
  config_id TEXT,

  -- Change details
  action TEXT NOT NULL, -- create|update|delete
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,

  -- Approval workflow
  requires_approval INTEGER DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,

  -- Request tracking
  request_id TEXT,
  ip_address TEXT,
  reason TEXT
);

-- =============================================================================
-- 5. SECURITY EVENTS (Threat Detection)
-- =============================================================================

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- Event severity
  severity TEXT NOT NULL, -- info|warning|critical
  event_type TEXT NOT NULL,

  -- Context
  user_id TEXT,
  organization_id TEXT,

  -- Threat details
  threat_indicator TEXT,
  threat_source TEXT,
  automated_response TEXT,

  -- Review workflow
  manual_review_required INTEGER DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,

  -- Request details
  request_data TEXT,
  metadata TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT
);

-- =============================================================================
-- 6. AUDIT RETENTION POLICY
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_retention_policy (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  table_name TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL,
  last_cleanup TEXT,
  records_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- =============================================================================
-- 7. CLEANUP JOBS TRACKING
-- =============================================================================

CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_type TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  records_processed INTEGER DEFAULT 0,
  records_deleted INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  error_message TEXT
);

-- =============================================================================
-- INDEXES FOR PERFORMANCE
-- =============================================================================

-- Main audit_logs indexes
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- Authentication audit indexes
CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_email ON auth_audit_logs(email, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_failures ON auth_audit_logs(success, timestamp DESC) WHERE success = 0;
CREATE INDEX IF NOT EXISTS idx_auth_audit_event_type ON auth_audit_logs(event_type, timestamp DESC);

-- Data access audit indexes
CREATE INDEX IF NOT EXISTS idx_data_access_user ON data_access_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_org ON data_access_logs(organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_source ON data_access_logs(data_source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_pii ON data_access_logs(contains_pii, timestamp DESC) WHERE contains_pii = 1;

-- Configuration audit indexes
CREATE INDEX IF NOT EXISTS idx_config_audit_user ON config_audit_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_config_audit_type ON config_audit_logs(config_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_config_audit_action ON config_audit_logs(action, timestamp DESC);

-- Security events indexes
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_review ON security_events(manual_review_required, timestamp DESC) WHERE manual_review_required = 1;

-- Cleanup jobs indexes
CREATE INDEX IF NOT EXISTS idx_cleanup_jobs_type ON cleanup_jobs(job_type, started_at DESC);

-- =============================================================================
-- DEFAULT RETENTION POLICIES
-- =============================================================================

-- Insert default retention policies (INSERT OR IGNORE = idempotent)
INSERT OR IGNORE INTO audit_retention_policy (table_name, retention_days) VALUES
  ('audit_logs', 365),           -- 1 year for general audit logs
  ('auth_audit_logs', 365),      -- 1 year for authentication events
  ('data_access_logs', 365),     -- 1 year for data access (SOC 2)
  ('config_audit_logs', 730),    -- 2 years for configuration changes
  ('security_events', 1095);     -- 3 years for security incidents
