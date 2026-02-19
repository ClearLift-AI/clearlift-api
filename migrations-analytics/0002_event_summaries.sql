-- Grouped migration: event_summaries
-- Tables: event_daily_summary, event_hourly_summary

-- Table: event_daily_summary
CREATE TABLE event_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  org_tag TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_count INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  unique_sessions INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, event_type)
);

-- Indexes for event_daily_summary
CREATE INDEX idx_eds_org_date ON event_daily_summary(organization_id, summary_date DESC);
CREATE INDEX idx_eds_org_tag ON event_daily_summary(org_tag, summary_date DESC);

-- Table: event_hourly_summary
CREATE TABLE event_hourly_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_hour TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_count INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_hour, event_type)
);

-- Indexes for event_hourly_summary
CREATE INDEX idx_ehs_org_hour ON event_hourly_summary(organization_id, summary_hour DESC);
