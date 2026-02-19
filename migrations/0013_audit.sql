-- Grouped migration: audit
-- Tables: audit_logs, auth_audit_logs, config_audit_logs, data_access_logs, security_events, audit_retention_policy, cleanup_jobs

-- Table: audit_logs
CREATE TABLE "audit_logs" (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  user_id TEXT,
  organization_id TEXT,
  session_token_hash TEXT,
  action TEXT NOT NULL,
  method TEXT,
  path TEXT,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  success INTEGER DEFAULT 1,
  status_code INTEGER,
  error_code TEXT,
  error_message TEXT,
  response_time_ms INTEGER,
  metadata TEXT
);

-- Indexes for audit_logs
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);

-- Table: auth_audit_logs
CREATE TABLE auth_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  user_id TEXT,
  email TEXT,
  auth_method TEXT,
  provider TEXT,
  ip_address TEXT,
  user_agent TEXT,
  success INTEGER DEFAULT 1,
  failure_reason TEXT,
  session_id TEXT,
  session_created INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for auth_audit_logs
CREATE INDEX idx_auth_audit_email ON auth_audit_logs(email, timestamp DESC);
CREATE INDEX idx_auth_audit_event ON auth_audit_logs(event_type);
CREATE INDEX idx_auth_audit_event_type ON auth_audit_logs(event_type, timestamp DESC);
CREATE INDEX idx_auth_audit_failures ON auth_audit_logs(success, timestamp DESC) WHERE success = 0;
CREATE INDEX idx_auth_audit_success ON auth_audit_logs(success);
CREATE INDEX idx_auth_audit_timestamp ON auth_audit_logs(timestamp);
CREATE INDEX idx_auth_audit_user ON auth_audit_logs(user_id);

-- Table: config_audit_logs
CREATE TABLE config_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  organization_id TEXT,
  config_type TEXT NOT NULL,
  config_id TEXT,
  action TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  requires_approval INTEGER DEFAULT 0,
  approved_by TEXT,
  approved_at DATETIME,
  request_id TEXT,
  ip_address TEXT,
  reason TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for config_audit_logs
CREATE INDEX idx_config_audit_action ON config_audit_logs(action, timestamp DESC);
CREATE INDEX idx_config_audit_org ON config_audit_logs(organization_id);
CREATE INDEX idx_config_audit_timestamp ON config_audit_logs(timestamp);
CREATE INDEX idx_config_audit_type ON config_audit_logs(config_type, timestamp DESC);
CREATE INDEX idx_config_audit_user ON config_audit_logs(user_id);

-- Table: data_access_logs
CREATE TABLE data_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  access_type TEXT NOT NULL,
  data_source TEXT NOT NULL,
  table_name TEXT,
  query_hash TEXT,
  filters_applied TEXT DEFAULT '{}',
  records_accessed INTEGER,
  fields_accessed TEXT DEFAULT '[]',
  query_time_ms INTEGER,
  export_format TEXT,
  export_destination TEXT,
  contains_pii INTEGER DEFAULT 0,
  data_classification TEXT DEFAULT 'internal',
  request_id TEXT,
  ip_address TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for data_access_logs
CREATE INDEX idx_data_access_org ON data_access_logs(organization_id);
CREATE INDEX idx_data_access_pii ON data_access_logs(contains_pii);
CREATE INDEX idx_data_access_source ON data_access_logs(data_source, timestamp DESC);
CREATE INDEX idx_data_access_timestamp ON data_access_logs(timestamp);
CREATE INDEX idx_data_access_user ON data_access_logs(user_id);

-- Table: security_events
CREATE TABLE security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  event_type TEXT NOT NULL,
  user_id TEXT,
  organization_id TEXT,
  threat_indicator TEXT,
  threat_source TEXT,
  automated_response TEXT,
  manual_review_required INTEGER DEFAULT 0,
  request_data TEXT,
  metadata TEXT DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for security_events
CREATE INDEX idx_security_events_review ON security_events(manual_review_required);
CREATE INDEX idx_security_events_severity ON security_events(severity);
CREATE INDEX idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX idx_security_events_type ON security_events(event_type, timestamp DESC);

-- Table: audit_retention_policy
CREATE TABLE audit_retention_policy (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  table_name TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL,
  last_cleanup TEXT,
  records_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Table: cleanup_jobs
CREATE TABLE cleanup_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_type TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  records_processed INTEGER DEFAULT 0,
  records_deleted INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  error_message TEXT
);

-- Indexes for cleanup_jobs
CREATE INDEX idx_cleanup_jobs_type ON cleanup_jobs(job_type, started_at DESC);
