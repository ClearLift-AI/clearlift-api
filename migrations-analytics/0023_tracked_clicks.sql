-- Grouped migration: tracked_clicks
-- Tables: tracked_clicks

-- Table: tracked_clicks
CREATE TABLE tracked_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  click_id TEXT,
  click_id_type TEXT,
  touchpoint_type TEXT NOT NULL,
  platform TEXT,
  campaign_id TEXT,
  ad_group_id TEXT,
  ad_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  landing_url TEXT,
  landing_path TEXT,
  referrer_url TEXT,
  referrer_domain TEXT,
  anonymous_id TEXT,
  session_id TEXT,
  user_id TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  region TEXT,
  click_timestamp TEXT NOT NULL,
  converted INTEGER DEFAULT 0,
  conversion_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for tracked_clicks
CREATE INDEX idx_tc_anon ON tracked_clicks(anonymous_id);
CREATE INDEX idx_tc_campaign ON tracked_clicks(organization_id, campaign_id);
CREATE INDEX idx_tc_click_id ON tracked_clicks(click_id);
CREATE INDEX idx_tc_converted ON tracked_clicks(organization_id, converted, click_timestamp DESC);
CREATE INDEX idx_tc_org_date ON tracked_clicks(organization_id, click_timestamp DESC);
CREATE INDEX idx_tc_session ON tracked_clicks(session_id);
CREATE UNIQUE INDEX idx_tracked_clicks_unique ON tracked_clicks(organization_id, click_id, click_timestamp) WHERE click_id IS NOT NULL;
