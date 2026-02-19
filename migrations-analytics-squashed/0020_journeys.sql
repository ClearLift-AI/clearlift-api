-- Grouped migration: journeys
-- Tables: journeys, journey_touchpoints, journey_analytics

-- Table: journeys
CREATE TABLE journeys (
  id TEXT PRIMARY KEY,
  org_tag TEXT NOT NULL,
  user_id_hash TEXT,
  anonymous_id TEXT NOT NULL,
  channel_path TEXT NOT NULL,
  path_length INTEGER NOT NULL,
  first_touch_ts TEXT NOT NULL,
  last_touch_ts TEXT NOT NULL,
  converted INTEGER DEFAULT 0,
  conversion_id TEXT,
  conversion_value_cents INTEGER DEFAULT 0,
  conversion_goal_id TEXT,
  time_to_conversion_hours REAL,
  computed_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for journeys
CREATE INDEX idx_j_org ON journeys(org_tag);
CREATE INDEX idx_j_org_anonymous_converted ON journeys(org_tag, anonymous_id, converted);
CREATE INDEX idx_j_org_converted ON journeys(org_tag, converted);
CREATE INDEX idx_j_org_converted_value ON journeys(org_tag, converted, conversion_value_cents DESC);
CREATE INDEX idx_j_org_goal ON journeys(org_tag, conversion_goal_id);
CREATE INDEX idx_j_org_ts ON journeys(org_tag, first_touch_ts DESC);
CREATE INDEX idx_j_org_user ON journeys(org_tag, user_id_hash) WHERE user_id_hash IS NOT NULL;

-- Table: journey_touchpoints
CREATE TABLE journey_touchpoints (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  touchpoint_type TEXT NOT NULL,
  touchpoint_source TEXT,
  touchpoint_timestamp TEXT NOT NULL,
  campaign_id TEXT,
  ad_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  page_url TEXT,
  page_path TEXT,
  page_title TEXT,
  referrer_url TEXT,
  conversion_id TEXT,
  conversion_value_cents INTEGER,
  touchpoint_number INTEGER,
  is_first_touch INTEGER DEFAULT 0,
  is_last_touch INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for journey_touchpoints
CREATE INDEX idx_jt_anon ON journey_touchpoints(anonymous_id, touchpoint_timestamp);
CREATE INDEX idx_jt_conv ON journey_touchpoints(conversion_id);
CREATE INDEX idx_jt_org_date ON journey_touchpoints(organization_id, touchpoint_timestamp DESC);
CREATE INDEX idx_jt_session ON journey_touchpoints(session_id);
CREATE INDEX idx_jt_user ON journey_touchpoints(user_id, touchpoint_timestamp);

-- Table: journey_analytics
CREATE TABLE "journey_analytics" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  channel_distribution TEXT NOT NULL,
  entry_channels TEXT NOT NULL,
  exit_channels TEXT NOT NULL,
  transition_matrix TEXT NOT NULL,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  converting_sessions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  avg_path_length REAL DEFAULT 0,
  common_paths TEXT NOT NULL,
  data_quality_level INTEGER DEFAULT 1,
  data_quality_report TEXT,
  total_conversions INTEGER DEFAULT 0,
  matched_conversions INTEGER DEFAULT 0,
  match_breakdown TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, period_start, period_end)
);

-- Indexes for journey_analytics
CREATE INDEX idx_journey_analytics_org ON journey_analytics(org_tag);
CREATE INDEX idx_journey_analytics_period ON journey_analytics(org_tag, period_start DESC, period_end DESC);
CREATE INDEX idx_journey_analytics_quality ON journey_analytics(org_tag, data_quality_level);
