-- Grouped migration: core_metrics
-- Tables: daily_metrics, hourly_metrics

-- Table: daily_metrics
CREATE TABLE daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  date TEXT NOT NULL,
  total_events INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  form_submits INTEGER DEFAULT 0,
  custom_events INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  devices INTEGER DEFAULT 0,
  new_users INTEGER DEFAULT 0,
  returning_users INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  by_channel TEXT,
  by_device TEXT,
  by_geo TEXT,
  by_page TEXT,
  by_utm_source TEXT,
  by_utm_campaign TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, date)
);

-- Indexes for daily_metrics
CREATE INDEX idx_dm_org_date ON daily_metrics(org_tag, date DESC);

-- Table: hourly_metrics
CREATE TABLE hourly_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  hour TEXT NOT NULL,
  total_events INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  form_submits INTEGER DEFAULT 0,
  custom_events INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  devices INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  by_channel TEXT,
  by_device TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  by_page TEXT,
  UNIQUE(org_tag, hour)
);

-- Indexes for hourly_metrics
CREATE INDEX idx_hm_org_hour ON hourly_metrics(org_tag, hour DESC);
CREATE INDEX idx_hourly_metrics_by_page ON hourly_metrics(org_tag, hour) WHERE by_page IS NOT NULL;
