-- Migration 0011: Complete Audit System
-- Fix audit_logs table and create missing audit tables for SOC 2 compliance

-- 0. Ensure audit_logs table exists (may have been created by deleted migration)
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    organization_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    ip_address TEXT,
    details TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1. Add missing columns to existing audit_logs table (ignore errors if columns exist)
ALTER TABLE audit_logs ADD COLUMN session_token_hash TEXT;
ALTER TABLE audit_logs ADD COLUMN method TEXT;
ALTER TABLE audit_logs ADD COLUMN path TEXT;
ALTER TABLE audit_logs ADD COLUMN user_agent TEXT;
ALTER TABLE audit_logs ADD COLUMN request_id TEXT;
ALTER TABLE audit_logs ADD COLUMN success INTEGER DEFAULT 1;
ALTER TABLE audit_logs ADD COLUMN status_code INTEGER;
ALTER TABLE audit_logs ADD COLUMN error_code TEXT;
ALTER TABLE audit_logs ADD COLUMN error_message TEXT;
ALTER TABLE audit_logs ADD COLUMN response_time_ms INTEGER;

-- Rename 'created_at' to 'timestamp' for consistency with audit logging standards
-- SQLite doesn't support RENAME COLUMN directly, so we create new column and migrate data
ALTER TABLE audit_logs ADD COLUMN timestamp DATETIME DEFAULT CURRENT_TIMESTAMP;
UPDATE audit_logs SET timestamp = created_at WHERE timestamp IS NULL;

-- 2. Create auth_audit_logs table for authentication events
CREATE TABLE IF NOT EXISTS auth_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, -- login|logout|session_refresh|oauth_connect|failed_login
    user_id TEXT,
    email TEXT,
    auth_method TEXT, -- password|oauth|api_key
    provider TEXT, -- google|facebook|stripe|etc
    ip_address TEXT,
    user_agent TEXT,
    success INTEGER DEFAULT 1,
    failure_reason TEXT,
    session_id TEXT,
    session_created INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Create data_access_logs table for SOC 2 data access tracking
CREATE TABLE IF NOT EXISTS data_access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    access_type TEXT NOT NULL, -- query|export|report|api_fetch
    data_source TEXT NOT NULL, -- r2_sql|supabase|d1|external_api
    table_name TEXT,
    query_hash TEXT, -- SHA-256 hash of query for pattern detection
    filters_applied TEXT DEFAULT '{}',
    records_accessed INTEGER,
    fields_accessed TEXT DEFAULT '[]',
    query_time_ms INTEGER,
    export_format TEXT, -- csv|json|pdf
    export_destination TEXT,
    contains_pii INTEGER DEFAULT 0,
    data_classification TEXT DEFAULT 'internal', -- public|internal|confidential|restricted
    request_id TEXT,
    ip_address TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Create config_audit_logs table for configuration change tracking
CREATE TABLE IF NOT EXISTS config_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    organization_id TEXT,
    config_type TEXT NOT NULL, -- connector|user|organization|system
    config_id TEXT,
    action TEXT NOT NULL, -- create|update|delete
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

-- 5. Create security_events table for security monitoring
CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    severity TEXT NOT NULL, -- info|warning|critical
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

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_timestamp ON auth_audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_auth_audit_event ON auth_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_auth_audit_success ON auth_audit_logs(success);

CREATE INDEX IF NOT EXISTS idx_data_access_user ON data_access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_data_access_org ON data_access_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_data_access_timestamp ON data_access_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_data_access_pii ON data_access_logs(contains_pii);

CREATE INDEX IF NOT EXISTS idx_config_audit_user ON config_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_config_audit_org ON config_audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_config_audit_timestamp ON config_audit_logs(timestamp);

CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_security_events_review ON security_events(manual_review_required);
