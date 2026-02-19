-- Track active event sync workflows per org to prevent pileup
-- Only one workflow should run at a time per org

CREATE TABLE IF NOT EXISTS active_event_workflows (
  org_tag TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_active_event_workflows_created
ON active_event_workflows(created_at);
