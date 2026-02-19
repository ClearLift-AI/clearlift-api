-- Grouped migration: tracking_links
-- Tables: tracking_link_clicks, tracking_link_daily_summary

-- Table: tracking_link_clicks
CREATE TABLE tracking_link_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  anonymous_id TEXT,
  session_id TEXT,
  user_id TEXT,
  referrer_url TEXT,
  landing_url TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  click_timestamp TEXT NOT NULL,
  converted INTEGER DEFAULT 0,
  conversion_id TEXT,
  conversion_value_cents INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for tracking_link_clicks
CREATE INDEX idx_tlc_anon ON tracking_link_clicks(anonymous_id);
CREATE INDEX idx_tlc_converted ON tracking_link_clicks(link_id, converted);
CREATE INDEX idx_tlc_link ON tracking_link_clicks(link_id, click_timestamp DESC);
CREATE INDEX idx_tlc_org ON tracking_link_clicks(organization_id, click_timestamp DESC);

-- Table: tracking_link_daily_summary
CREATE TABLE tracking_link_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  total_clicks INTEGER DEFAULT 0,
  unique_clicks INTEGER DEFAULT 0,
  desktop_clicks INTEGER DEFAULT 0,
  mobile_clicks INTEGER DEFAULT 0,
  tablet_clicks INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  conversion_rate REAL,
  top_country TEXT,
  top_country_clicks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, link_id, summary_date)
);

-- Indexes for tracking_link_daily_summary
CREATE INDEX idx_tlds_link ON tracking_link_daily_summary(link_id, summary_date DESC);
CREATE INDEX idx_tlds_org_date ON tracking_link_daily_summary(organization_id, summary_date DESC);
