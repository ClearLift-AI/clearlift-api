-- Grouped migration: utm
-- Tables: utm_performance

-- Table: utm_performance
CREATE TABLE utm_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  date TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  avg_session_duration_seconds INTEGER,
  bounce_rate REAL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, date, utm_source, utm_medium, utm_campaign)
);

-- Indexes for utm_performance
CREATE INDEX idx_utm_org_campaign ON utm_performance(org_tag, utm_campaign);
CREATE INDEX idx_utm_org_date ON utm_performance(org_tag, date DESC);
CREATE INDEX idx_utm_org_source ON utm_performance(org_tag, utm_source);
