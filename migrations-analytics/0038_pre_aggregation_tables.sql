-- ============================================================================
-- Pre-Aggregation Tables for Dashboard Performance
-- These tables store pre-computed summaries to avoid expensive aggregation queries
-- Updated nightly by aggregation cron worker
-- ============================================================================

-- ============================================================================
-- ORG DAILY SUMMARY
-- One row per org per platform per day
-- Dashboard overview reads from this instead of scanning all campaigns
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_daily_summary (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    platform TEXT NOT NULL,  -- 'google', 'facebook', 'tiktok', 'stripe'
    metric_date TEXT NOT NULL,  -- YYYY-MM-DD

    -- Aggregated metrics
    total_spend_cents INTEGER NOT NULL DEFAULT 0,
    total_impressions INTEGER NOT NULL DEFAULT 0,
    total_clicks INTEGER NOT NULL DEFAULT 0,
    total_conversions REAL NOT NULL DEFAULT 0,
    total_conversion_value_cents INTEGER NOT NULL DEFAULT 0,

    -- Entity counts
    active_campaigns INTEGER NOT NULL DEFAULT 0,
    active_ad_groups INTEGER NOT NULL DEFAULT 0,
    active_ads INTEGER NOT NULL DEFAULT 0,

    -- Pre-calculated derived metrics
    ctr REAL DEFAULT 0,  -- clicks / impressions
    cpc_cents INTEGER DEFAULT 0,  -- spend / clicks
    cpm_cents INTEGER DEFAULT 0,  -- spend / impressions * 1000
    roas REAL DEFAULT 0,  -- conversion_value / spend
    cpa_cents INTEGER DEFAULT 0,  -- spend / conversions

    -- Stripe-specific (only when platform = 'stripe')
    total_revenue_cents INTEGER DEFAULT 0,
    total_charges INTEGER DEFAULT 0,
    total_refunds_cents INTEGER DEFAULT 0,

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),

    UNIQUE(organization_id, platform, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_org_daily_summary_org ON org_daily_summary(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_daily_summary_org_date ON org_daily_summary(organization_id, metric_date);
CREATE INDEX IF NOT EXISTS idx_org_daily_summary_platform ON org_daily_summary(organization_id, platform, metric_date);

-- ============================================================================
-- CAMPAIGN PERIOD SUMMARY
-- Rolling period aggregates for campaign list views
-- Avoids scanning 90 days of metrics per campaign
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaign_period_summary (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    platform TEXT NOT NULL,  -- 'google', 'facebook', 'tiktok'
    campaign_id TEXT NOT NULL,  -- Platform's campaign ID
    campaign_ref TEXT,  -- Internal UUID reference
    campaign_name TEXT NOT NULL,
    campaign_status TEXT NOT NULL,
    period_type TEXT NOT NULL,  -- '7d', '30d', '90d'
    period_start TEXT NOT NULL,  -- YYYY-MM-DD
    period_end TEXT NOT NULL,    -- YYYY-MM-DD

    -- Aggregated metrics
    total_spend_cents INTEGER NOT NULL DEFAULT 0,
    total_impressions INTEGER NOT NULL DEFAULT 0,
    total_clicks INTEGER NOT NULL DEFAULT 0,
    total_conversions REAL NOT NULL DEFAULT 0,
    total_conversion_value_cents INTEGER NOT NULL DEFAULT 0,

    -- Derived metrics
    ctr REAL DEFAULT 0,
    cpc_cents INTEGER DEFAULT 0,
    cpm_cents INTEGER DEFAULT 0,
    roas REAL DEFAULT 0,
    cpa_cents INTEGER DEFAULT 0,

    -- Trend data (vs previous period)
    prev_spend_cents INTEGER DEFAULT 0,
    prev_conversions REAL DEFAULT 0,
    spend_change_pct REAL DEFAULT 0,
    conversions_change_pct REAL DEFAULT 0,

    -- Budget utilization
    budget_cents INTEGER DEFAULT 0,
    budget_utilization_pct REAL DEFAULT 0,

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),

    UNIQUE(organization_id, platform, campaign_id, period_type)
);

CREATE INDEX IF NOT EXISTS idx_campaign_period_org ON campaign_period_summary(organization_id);
CREATE INDEX IF NOT EXISTS idx_campaign_period_platform ON campaign_period_summary(organization_id, platform);
CREATE INDEX IF NOT EXISTS idx_campaign_period_type ON campaign_period_summary(organization_id, platform, period_type);

-- ============================================================================
-- PLATFORM COMPARISON
-- Pre-calculated cross-platform comparison data
-- For the dashboard's platform comparison tab
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_comparison (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    comparison_date TEXT NOT NULL,  -- YYYY-MM-DD (represents the period end)
    period_days INTEGER NOT NULL DEFAULT 30,  -- 7, 30, 90

    -- Google totals
    google_spend_cents INTEGER DEFAULT 0,
    google_impressions INTEGER DEFAULT 0,
    google_clicks INTEGER DEFAULT 0,
    google_conversions REAL DEFAULT 0,
    google_conversion_value_cents INTEGER DEFAULT 0,
    google_roas REAL DEFAULT 0,
    google_ctr REAL DEFAULT 0,
    google_cpc_cents INTEGER DEFAULT 0,

    -- Facebook totals
    facebook_spend_cents INTEGER DEFAULT 0,
    facebook_impressions INTEGER DEFAULT 0,
    facebook_clicks INTEGER DEFAULT 0,
    facebook_conversions REAL DEFAULT 0,
    facebook_conversion_value_cents INTEGER DEFAULT 0,
    facebook_roas REAL DEFAULT 0,
    facebook_ctr REAL DEFAULT 0,
    facebook_cpc_cents INTEGER DEFAULT 0,

    -- TikTok totals
    tiktok_spend_cents INTEGER DEFAULT 0,
    tiktok_impressions INTEGER DEFAULT 0,
    tiktok_clicks INTEGER DEFAULT 0,
    tiktok_conversions REAL DEFAULT 0,
    tiktok_conversion_value_cents INTEGER DEFAULT 0,
    tiktok_roas REAL DEFAULT 0,
    tiktok_ctr REAL DEFAULT 0,
    tiktok_cpc_cents INTEGER DEFAULT 0,

    -- Stripe totals (revenue)
    stripe_revenue_cents INTEGER DEFAULT 0,
    stripe_charges INTEGER DEFAULT 0,
    stripe_avg_order_value_cents INTEGER DEFAULT 0,

    -- Combined totals
    total_spend_cents INTEGER DEFAULT 0,
    total_impressions INTEGER DEFAULT 0,
    total_clicks INTEGER DEFAULT 0,
    total_conversions REAL DEFAULT 0,
    total_conversion_value_cents INTEGER DEFAULT 0,
    blended_roas REAL DEFAULT 0,
    blended_ctr REAL DEFAULT 0,
    blended_cpc_cents INTEGER DEFAULT 0,

    -- Trend vs previous period
    spend_change_pct REAL DEFAULT 0,
    conversions_change_pct REAL DEFAULT 0,
    revenue_change_pct REAL DEFAULT 0,

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),

    UNIQUE(organization_id, comparison_date, period_days)
);

CREATE INDEX IF NOT EXISTS idx_platform_comparison_org ON platform_comparison(organization_id);
CREATE INDEX IF NOT EXISTS idx_platform_comparison_date ON platform_comparison(organization_id, comparison_date);
CREATE INDEX IF NOT EXISTS idx_platform_comparison_period ON platform_comparison(organization_id, period_days, comparison_date);

-- ============================================================================
-- DAILY TIMESERIES (for charts)
-- Pre-aggregated daily data for sparklines and trend charts
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_timeseries (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,  -- YYYY-MM-DD

    -- Combined across all platforms
    total_spend_cents INTEGER DEFAULT 0,
    total_impressions INTEGER DEFAULT 0,
    total_clicks INTEGER DEFAULT 0,
    total_conversions REAL DEFAULT 0,
    total_revenue_cents INTEGER DEFAULT 0,  -- From Stripe

    -- Blended metrics
    blended_roas REAL DEFAULT 0,
    blended_ctr REAL DEFAULT 0,

    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),

    UNIQUE(organization_id, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_org_timeseries_org_date ON org_timeseries(organization_id, metric_date);

-- ============================================================================
-- AGGREGATION JOB TRACKING
-- Track when aggregations last ran for each org
-- ============================================================================

CREATE TABLE IF NOT EXISTS aggregation_jobs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    job_type TEXT NOT NULL,  -- 'daily_summary', 'campaign_summary', 'platform_comparison'
    last_run_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    rows_processed INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),

    UNIQUE(organization_id, job_type)
);

CREATE INDEX IF NOT EXISTS idx_aggregation_jobs_org ON aggregation_jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_aggregation_jobs_last_run ON aggregation_jobs(last_run_at);
