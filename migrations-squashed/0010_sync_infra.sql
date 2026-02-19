-- Grouped migration: sync_infra
-- Tables: sync_jobs, event_sync_watermarks, active_event_workflows, active_shopify_workflows

-- Table: sync_jobs
CREATE TABLE "sync_jobs" (
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
  current_phase TEXT,
  total_records INTEGER,
  progress_percentage INTEGER DEFAULT 0,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for sync_jobs
CREATE INDEX idx_sync_jobs_connection_status ON sync_jobs(connection_id, status);
CREATE INDEX idx_sync_jobs_status_created ON sync_jobs(status, created_at);

-- Table: event_sync_watermarks
CREATE TABLE event_sync_watermarks (
  org_tag TEXT PRIMARY KEY,
  last_synced_timestamp TEXT NOT NULL,
  last_synced_event_id TEXT,
  records_synced INTEGER DEFAULT 0,
  last_sync_status TEXT NOT NULL CHECK(last_sync_status IN ('success', 'partial', 'failed')),
  last_sync_error TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for event_sync_watermarks
CREATE INDEX idx_event_sync_watermarks_status ON event_sync_watermarks(last_sync_status);
CREATE INDEX idx_event_sync_watermarks_timestamp ON event_sync_watermarks(last_synced_timestamp);

-- Triggers for event_sync_watermarks
CREATE TRIGGER update_event_sync_watermarks_timestamp
    AFTER UPDATE ON event_sync_watermarks
    FOR EACH ROW
BEGIN
    UPDATE event_sync_watermarks
    SET updated_at = datetime('now')
    WHERE org_tag = NEW.org_tag;
END;

-- Table: active_event_workflows
CREATE TABLE active_event_workflows (
  org_tag TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for active_event_workflows
CREATE INDEX idx_active_event_workflows_created ON active_event_workflows(created_at);

-- Table: active_shopify_workflows
CREATE TABLE active_shopify_workflows (
  connection_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for active_shopify_workflows
CREATE INDEX idx_active_shopify_workflows_created ON active_shopify_workflows(created_at);
