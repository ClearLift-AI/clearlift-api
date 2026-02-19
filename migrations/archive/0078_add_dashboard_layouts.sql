-- Dashboard layouts: one row per org, stores full TabbedDashboardLayout JSON
CREATE TABLE IF NOT EXISTS dashboard_layouts (
  organization_id TEXT PRIMARY KEY,
  layout_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id)
);
