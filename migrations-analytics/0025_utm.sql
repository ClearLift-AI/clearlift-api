-- Grouped migration: utm
-- Tables: utm_performance, utm_daily_performance

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

-- Table: utm_daily_performance
CREATE TABLE utm_daily_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  clicks INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  unique_sessions INTEGER DEFAULT 0,
  bounce_count INTEGER DEFAULT 0,
  total_session_duration_seconds INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  assisted_conversions INTEGER DEFAULT 0,
  form_submissions INTEGER DEFAULT 0,
  video_plays INTEGER DEFAULT 0,
  scroll_depth_avg REAL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
);

-- Indexes for utm_daily_performance
CREATE INDEX idx_udp_campaign ON utm_daily_performance(organization_id, utm_campaign);
CREATE INDEX idx_udp_org_date ON utm_daily_performance(organization_id, summary_date DESC);
CREATE INDEX idx_udp_source ON utm_daily_performance(organization_id, utm_source);
