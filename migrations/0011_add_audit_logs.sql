-- Audit logging tables for SOC 2 compliance
-- Tracks all API access, data modifications, and security events

-- Main audit log table
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- User context
  user_id TEXT,
  organization_id TEXT,
  session_token_hash TEXT, -- Hashed for security

  -- Request details
  action TEXT NOT NULL, -- e.g., 'api.request', 'data.access', 'auth.login'
  method TEXT, -- HTTP method
  path TEXT, -- API endpoint path
  resource_type TEXT, -- e.g., 'connection', 'organization', 'sync_job'
  resource_id TEXT, -- ID of the affected resource

  -- Network details
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,

  -- Result
  success INTEGER DEFAULT 1, -- 1 for success, 0 for failure
  status_code INTEGER,
  error_code TEXT,
  error_message TEXT,

  -- Performance
  response_time_ms INTEGER,

  -- Additional context (JSON)
  metadata TEXT,

  -- Indexes for efficient querying
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

-- Indexes for efficient audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_timestamp ON audit_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_timestamp ON audit_logs(organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_timestamp ON audit_logs(action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_failures ON audit_logs(success, timestamp DESC) WHERE success = 0;
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);

-- Authentication audit log (detailed auth events)
CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- Event details
  event_type TEXT NOT NULL, -- 'login', 'logout', 'session_refresh', 'oauth_connect', 'failed_login'
  user_id TEXT,
  email TEXT,

  -- Authentication details
  auth_method TEXT, -- 'session', 'oauth', 'api_key'
  provider TEXT, -- 'cloudflare_access', 'google', 'facebook', etc.

  -- Network details
  ip_address TEXT,
  user_agent TEXT,

  -- Result
  success INTEGER DEFAULT 1,
  failure_reason TEXT, -- 'invalid_credentials', 'expired_session', 'account_locked'

  -- Session management
  session_id TEXT,
  session_created INTEGER DEFAULT 0, -- 1 if new session was created

  -- Additional context
  metadata TEXT -- JSON with additional details
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_user_timestamp ON auth_audit_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_email_timestamp ON auth_audit_logs(email, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_failures ON auth_audit_logs(success, timestamp DESC) WHERE success = 0;
CREATE INDEX IF NOT EXISTS idx_auth_audit_event_type ON auth_audit_logs(event_type, timestamp DESC);

-- Data access audit log (tracks data queries and exports)
CREATE TABLE IF NOT EXISTS data_access_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- User context
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,

  -- Access details
  access_type TEXT NOT NULL, -- 'query', 'export', 'report', 'api_fetch'
  data_source TEXT NOT NULL, -- 'r2_sql', 'supabase', 'd1', 'external_api'
  table_name TEXT,

  -- Query details
  query_hash TEXT, -- Hash of the query for pattern detection
  filters_applied TEXT, -- JSON of filter conditions

  -- Volume
  records_accessed INTEGER,
  fields_accessed TEXT, -- JSON array of field names

  -- Performance
  query_time_ms INTEGER,

  -- Export tracking
  export_format TEXT, -- 'json', 'csv', 'excel', null if not export
  export_destination TEXT, -- 'download', 'email', 'webhook'

  -- Compliance
  contains_pii INTEGER DEFAULT 0, -- 1 if PII was accessed
  data_classification TEXT, -- 'public', 'internal', 'confidential', 'restricted'

  -- Request context
  request_id TEXT,
  ip_address TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_data_access_user_timestamp ON data_access_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_org_timestamp ON data_access_logs(organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_source ON data_access_logs(data_source, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_pii ON data_access_logs(contains_pii, timestamp DESC) WHERE contains_pii = 1;

-- Configuration change audit log
CREATE TABLE IF NOT EXISTS config_audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- User context
  user_id TEXT NOT NULL,
  organization_id TEXT,

  -- Change details
  config_type TEXT NOT NULL, -- 'connection', 'organization', 'user_role', 'integration'
  config_id TEXT,
  action TEXT NOT NULL, -- 'create', 'update', 'delete'

  -- Change tracking
  field_name TEXT,
  old_value TEXT, -- Encrypted if sensitive
  new_value TEXT, -- Encrypted if sensitive

  -- Approval workflow (if applicable)
  requires_approval INTEGER DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,

  -- Request context
  request_id TEXT,
  ip_address TEXT,
  reason TEXT, -- Reason for change if provided

  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_config_audit_user_timestamp ON config_audit_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_config_audit_type ON config_audit_logs(config_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_config_audit_action ON config_audit_logs(action, timestamp DESC);

-- Security events log (for incident response)
CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),

  -- Event classification
  severity TEXT NOT NULL, -- 'info', 'warning', 'critical'
  event_type TEXT NOT NULL, -- 'brute_force', 'sql_injection', 'unauthorized_access', 'data_exfiltration'

  -- User context (if available)
  user_id TEXT,
  organization_id TEXT,

  -- Threat details
  threat_indicator TEXT, -- What triggered the event
  threat_source TEXT, -- IP, user agent, etc.

  -- Response
  automated_response TEXT, -- 'blocked', 'rate_limited', 'logged_only'
  manual_review_required INTEGER DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_notes TEXT,

  -- Evidence
  request_data TEXT, -- Sanitized request that triggered event
  metadata TEXT, -- Additional context

  -- Network details
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_review ON security_events(manual_review_required, timestamp DESC) WHERE manual_review_required = 1;

-- Add audit log retention metadata table
CREATE TABLE IF NOT EXISTS audit_retention_policy (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  table_name TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL,
  last_cleanup TEXT,
  records_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Insert default retention policies (SOC 2 requires minimum 1 year)
INSERT INTO audit_retention_policy (table_name, retention_days) VALUES
  ('audit_logs', 365),
  ('auth_audit_logs', 365),
  ('data_access_logs', 365),
  ('config_audit_logs', 730), -- 2 years for configuration changes
  ('security_events', 1095); -- 3 years for security incidents

-- Session cleanup tracking
CREATE TABLE IF NOT EXISTS cleanup_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_type TEXT NOT NULL, -- 'session_cleanup', 'oauth_state_cleanup', 'audit_archive'
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  records_processed INTEGER DEFAULT 0,
  records_deleted INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_cleanup_jobs_type ON cleanup_jobs(job_type, started_at DESC);