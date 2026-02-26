-- Grouped migration: pre_aggregation
-- Tables: org_daily_summary, org_timeseries, campaign_period_summary, platform_comparison

-- Table: org_daily_summary
CREATE TABLE org_daily_summary (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  total_spend_cents INTEGER NOT NULL DEFAULT 0,
  total_impressions INTEGER NOT NULL DEFAULT 0,
  total_clicks INTEGER NOT NULL DEFAULT 0,
  total_conversions REAL NOT NULL DEFAULT 0,
  total_conversion_value_cents INTEGER NOT NULL DEFAULT 0,
  active_campaigns INTEGER NOT NULL DEFAULT 0,
  active_ad_groups INTEGER NOT NULL DEFAULT 0,
  active_ads INTEGER NOT NULL DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  roas REAL DEFAULT 0,
  cpa_cents INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  total_charges INTEGER DEFAULT 0,
  total_refunds_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, metric_date)
);

-- Indexes for org_daily_summary
CREATE INDEX idx_org_daily_summary_org ON org_daily_summary(organization_id);
CREATE INDEX idx_org_daily_summary_org_date ON org_daily_summary(organization_id, metric_date);
CREATE INDEX idx_org_daily_summary_platform ON org_daily_summary(organization_id, platform, metric_date);

-- Table: org_timeseries
CREATE TABLE org_timeseries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  total_spend_cents INTEGER DEFAULT 0,
  total_impressions INTEGER DEFAULT 0,
  total_clicks INTEGER DEFAULT 0,
  total_conversions REAL DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  blended_roas REAL DEFAULT 0,
  blended_ctr REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, metric_date)
);

-- Indexes for org_timeseries
CREATE INDEX idx_org_timeseries_org_date ON org_timeseries(organization_id, metric_date);

-- Table: campaign_period_summary
CREATE TABLE campaign_period_summary (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_ref TEXT,
  campaign_name TEXT NOT NULL,
  campaign_status TEXT NOT NULL,
  period_type TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total_spend_cents INTEGER NOT NULL DEFAULT 0,
  total_impressions INTEGER NOT NULL DEFAULT 0,
  total_clicks INTEGER NOT NULL DEFAULT 0,
  total_conversions REAL NOT NULL DEFAULT 0,
  total_conversion_value_cents INTEGER NOT NULL DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  roas REAL DEFAULT 0,
  cpa_cents INTEGER DEFAULT 0,
  prev_spend_cents INTEGER DEFAULT 0,
  prev_conversions REAL DEFAULT 0,
  spend_change_pct REAL DEFAULT 0,
  conversions_change_pct REAL DEFAULT 0,
  budget_cents INTEGER DEFAULT 0,
  budget_utilization_pct REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, campaign_id, period_type)
);

-- Indexes for campaign_period_summary
CREATE INDEX idx_campaign_period_org ON campaign_period_summary(organization_id);
CREATE INDEX idx_campaign_period_platform ON campaign_period_summary(organization_id, platform);
CREATE INDEX idx_campaign_period_type ON campaign_period_summary(organization_id, platform, period_type);

-- Table: platform_comparison
CREATE TABLE platform_comparison (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  comparison_date TEXT NOT NULL,
  period_days INTEGER NOT NULL DEFAULT 30,
  google_spend_cents INTEGER DEFAULT 0,
  google_impressions INTEGER DEFAULT 0,
  google_clicks INTEGER DEFAULT 0,
  google_conversions REAL DEFAULT 0,
  google_conversion_value_cents INTEGER DEFAULT 0,
  google_roas REAL DEFAULT 0,
  google_ctr REAL DEFAULT 0,
  google_cpc_cents INTEGER DEFAULT 0,
  facebook_spend_cents INTEGER DEFAULT 0,
  facebook_impressions INTEGER DEFAULT 0,
  facebook_clicks INTEGER DEFAULT 0,
  facebook_conversions REAL DEFAULT 0,
  facebook_conversion_value_cents INTEGER DEFAULT 0,
  facebook_roas REAL DEFAULT 0,
  facebook_ctr REAL DEFAULT 0,
  facebook_cpc_cents INTEGER DEFAULT 0,
  tiktok_spend_cents INTEGER DEFAULT 0,
  tiktok_impressions INTEGER DEFAULT 0,
  tiktok_clicks INTEGER DEFAULT 0,
  tiktok_conversions REAL DEFAULT 0,
  tiktok_conversion_value_cents INTEGER DEFAULT 0,
  tiktok_roas REAL DEFAULT 0,
  tiktok_ctr REAL DEFAULT 0,
  tiktok_cpc_cents INTEGER DEFAULT 0,
  stripe_revenue_cents INTEGER DEFAULT 0,
  stripe_charges INTEGER DEFAULT 0,
  stripe_avg_order_value_cents INTEGER DEFAULT 0,
  total_spend_cents INTEGER DEFAULT 0,
  total_impressions INTEGER DEFAULT 0,
  total_clicks INTEGER DEFAULT 0,
  total_conversions REAL DEFAULT 0,
  total_conversion_value_cents INTEGER DEFAULT 0,
  blended_roas REAL DEFAULT 0,
  blended_ctr REAL DEFAULT 0,
  blended_cpc_cents INTEGER DEFAULT 0,
  spend_change_pct REAL DEFAULT 0,
  conversions_change_pct REAL DEFAULT 0,
  revenue_change_pct REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, comparison_date, period_days)
);

-- Indexes for platform_comparison
CREATE INDEX idx_platform_comparison_date ON platform_comparison(organization_id, comparison_date);
CREATE INDEX idx_platform_comparison_org ON platform_comparison(organization_id);
CREATE INDEX idx_platform_comparison_period ON platform_comparison(organization_id, period_days, comparison_date);
