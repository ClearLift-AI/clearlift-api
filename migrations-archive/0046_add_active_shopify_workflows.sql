-- Track active Shopify sync workflows per connection to prevent pileup
-- Only one workflow should run at a time per connection
-- Uses connection_id as key since each Shopify store has its own connection

CREATE TABLE IF NOT EXISTS active_shopify_workflows (
  connection_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for quick lookups and cleanup of stale records
CREATE INDEX IF NOT EXISTS idx_active_shopify_workflows_created
ON active_shopify_workflows(created_at);
