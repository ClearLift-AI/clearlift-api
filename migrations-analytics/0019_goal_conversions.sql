-- Grouped migration: goal_conversions
-- Tables: goal_conversions, goal_metrics_daily, goal_completion_metrics

-- Table: goal_conversions
CREATE TABLE goal_conversions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  conversion_id TEXT,
  conversion_source TEXT NOT NULL,
  source_platform TEXT,
  source_event_id TEXT,
  value_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  attribution_model TEXT,
  attribution_data TEXT,
  attributed_campaign_id TEXT,
  attributed_ad_id TEXT,
  conversion_timestamp TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  unified_event_type TEXT,
  link_method TEXT,
  link_confidence REAL
);

-- Indexes for goal_conversions
CREATE INDEX idx_gc_conv ON goal_conversions(conversion_id);
CREATE INDEX idx_gc_goal ON goal_conversions(goal_id, conversion_timestamp DESC);
CREATE INDEX idx_goal_conv_unified_type ON goal_conversions(organization_id, unified_event_type);
CREATE UNIQUE INDEX idx_goal_conversions_dedup ON goal_conversions(organization_id, goal_id, source_event_id);

-- Table: goal_metrics_daily
CREATE TABLE goal_metrics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  conversion_rate REAL,
  conversions_platform INTEGER DEFAULT 0,
  conversions_tag INTEGER DEFAULT 0,
  conversions_connector INTEGER DEFAULT 0,
  value_platform_cents INTEGER DEFAULT 0,
  value_tag_cents INTEGER DEFAULT 0,
  value_connector_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, goal_id, summary_date)
);

-- Indexes for goal_metrics_daily
CREATE INDEX idx_gmd_goal ON goal_metrics_daily(goal_id, summary_date DESC);
CREATE INDEX idx_gmd_org_date ON goal_metrics_daily(organization_id, summary_date DESC);

-- Table: goal_completion_metrics
CREATE TABLE goal_completion_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  date TEXT NOT NULL,
  goal_name TEXT,
  goal_type TEXT,
  funnel_position INTEGER,
  completions INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  completion_value_cents INTEGER NOT NULL DEFAULT 0,
  downstream_conversions INTEGER NOT NULL DEFAULT 0,
  downstream_conversion_rate REAL NOT NULL DEFAULT 0,
  downstream_revenue_cents INTEGER NOT NULL DEFAULT 0,
  by_channel TEXT,
  by_utm_source TEXT,
  by_device TEXT,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, goal_id, date)
);

-- Indexes for goal_completion_metrics
CREATE INDEX idx_gcm_org_date ON goal_completion_metrics(org_tag, date DESC);
CREATE INDEX idx_gcm_org_goal ON goal_completion_metrics(org_tag, goal_id);
CREATE INDEX idx_gcm_org_type ON goal_completion_metrics(org_tag, goal_type);
