-- Grouped migration: analytics_infra
-- Tables: aggregation_jobs, connector_sync_status, sync_watermarks, cleanup_log, domain_claims

-- Table: aggregation_jobs
CREATE TABLE aggregation_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  rows_processed INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, job_type)
);

-- Indexes for aggregation_jobs
CREATE INDEX idx_aggregation_jobs_last_run ON aggregation_jobs(last_run_at);
CREATE INDEX idx_aggregation_jobs_org ON aggregation_jobs(organization_id);

-- Table: connector_sync_status
CREATE TABLE connector_sync_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  account_id TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT,
  records_synced INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connector_type, account_id)
);

-- Indexes for connector_sync_status
CREATE INDEX idx_css_org ON connector_sync_status(organization_id);
CREATE INDEX idx_css_type ON connector_sync_status(connector_type);

-- Table: sync_watermarks
CREATE TABLE sync_watermarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  sync_type TEXT NOT NULL,
  last_synced_ts TEXT NOT NULL,
  last_ingest_ts TEXT,
  records_synced INTEGER DEFAULT 0,
  status TEXT DEFAULT 'success',
  error_message TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, sync_type)
);

-- Indexes for sync_watermarks
CREATE INDEX idx_sw_org ON sync_watermarks(org_tag);

-- Table: cleanup_log
CREATE TABLE cleanup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  org_tag TEXT,
  records_deleted INTEGER DEFAULT 0,
  retention_days INTEGER NOT NULL,
  run_at TEXT DEFAULT (datetime('now'))
);

-- Table: domain_claims
CREATE TABLE domain_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  org_tag TEXT NOT NULL,
  domain_pattern TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  claimed_at TEXT DEFAULT (datetime('now')),
  released_at TEXT,
  verified INTEGER DEFAULT 0,
  verification_token TEXT,
  UNIQUE(domain_pattern, org_tag)
);

-- Indexes for domain_claims
CREATE INDEX idx_dc_active ON domain_claims(is_active, org_tag);
CREATE INDEX idx_dc_domain ON domain_claims(domain_pattern);
CREATE INDEX idx_dc_org ON domain_claims(organization_id);
CREATE INDEX idx_dc_tag ON domain_claims(org_tag);
