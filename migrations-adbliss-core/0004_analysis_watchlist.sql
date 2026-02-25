-- Agent watchlist: persistent cross-run memory for the analysis agent
CREATE TABLE IF NOT EXISTS analysis_watchlist (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  entity_ref TEXT,
  entity_name TEXT,
  platform TEXT,
  entity_type TEXT,
  watch_type TEXT NOT NULL,
  note TEXT NOT NULL,
  review_after TEXT,
  created_by_job_id TEXT,
  resolved_by_job_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
CREATE INDEX idx_watchlist_org_status ON analysis_watchlist(organization_id, status);
CREATE INDEX idx_watchlist_review ON analysis_watchlist(organization_id, status, review_after);
