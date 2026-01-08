-- ============================================================================
-- SHARD SCHEMA: Platform Data Tables
-- Applied to each D1 shard database (SHARD_0 through SHARD_15)
-- ============================================================================
-- This schema mirrors Supabase but uses SQLite-compatible types
-- Table naming: {platform}_{entity} instead of schemas
-- ============================================================================

-- ============================================================================
-- GOOGLE ADS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS google_campaigns (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT NOT NULL,
    campaign_status TEXT NOT NULL CHECK (campaign_status IN ('ENABLED', 'PAUSED', 'REMOVED')),
    campaign_type TEXT NOT NULL,
    budget_amount_cents INTEGER,
    budget_type TEXT,
    bidding_strategy_type TEXT,
    target_cpa_cents INTEGER,
    target_roas REAL,
    campaign_start_date TEXT,
    campaign_end_date TEXT,
    raw_data TEXT,  -- JSON blob for full API response
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    api_version TEXT DEFAULT 'v22',
    UNIQUE(organization_id, customer_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_google_campaigns_org ON google_campaigns(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_google_campaigns_status ON google_campaigns(organization_id, campaign_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_google_campaigns_synced ON google_campaigns(last_synced_at);

CREATE TABLE IF NOT EXISTS google_ad_groups (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES google_campaigns(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_group_id TEXT NOT NULL,
    ad_group_name TEXT NOT NULL,
    ad_group_status TEXT NOT NULL CHECK (ad_group_status IN ('ENABLED', 'PAUSED', 'REMOVED')),
    ad_group_type TEXT,
    cpc_bid_cents INTEGER,
    cpm_bid_cents INTEGER,
    target_cpa_cents INTEGER,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    api_version TEXT DEFAULT 'v22',
    UNIQUE(organization_id, customer_id, campaign_id, ad_group_id)
);

CREATE INDEX IF NOT EXISTS idx_google_ad_groups_org ON google_ad_groups(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_google_ad_groups_campaign ON google_ad_groups(campaign_ref) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS google_ads (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES google_campaigns(id) ON DELETE CASCADE,
    ad_group_ref TEXT NOT NULL REFERENCES google_ad_groups(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_group_id TEXT NOT NULL,
    ad_id TEXT NOT NULL,
    ad_name TEXT,
    ad_status TEXT NOT NULL CHECK (ad_status IN ('ENABLED', 'PAUSED', 'REMOVED')),
    ad_type TEXT NOT NULL,
    headlines TEXT,  -- JSON array
    descriptions TEXT,  -- JSON array
    final_urls TEXT,  -- JSON array
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    api_version TEXT DEFAULT 'v22',
    UNIQUE(organization_id, customer_id, campaign_id, ad_group_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_google_ads_org ON google_ads(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group ON google_ads(ad_group_ref) WHERE deleted_at IS NULL;

-- Google Metrics Tables
CREATE TABLE IF NOT EXISTS google_campaign_metrics (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES google_campaigns(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    all_conversions REAL DEFAULT 0,
    video_views INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, campaign_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_google_campaign_metrics_org_date ON google_campaign_metrics(organization_id, metric_date);
CREATE INDEX IF NOT EXISTS idx_google_campaign_metrics_campaign ON google_campaign_metrics(campaign_ref, metric_date);

CREATE TABLE IF NOT EXISTS google_ad_group_metrics (
    id TEXT PRIMARY KEY,
    ad_group_ref TEXT NOT NULL REFERENCES google_ad_groups(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, ad_group_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_google_ad_group_metrics_org_date ON google_ad_group_metrics(organization_id, metric_date);

CREATE TABLE IF NOT EXISTS google_ad_metrics (
    id TEXT PRIMARY KEY,
    ad_ref TEXT NOT NULL REFERENCES google_ads(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, ad_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_google_ad_metrics_org_date ON google_ad_metrics(organization_id, metric_date);

-- ============================================================================
-- FACEBOOK ADS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS facebook_campaigns (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT NOT NULL,
    campaign_status TEXT NOT NULL CHECK (campaign_status IN ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED')),
    objective TEXT,
    budget_amount_cents INTEGER,
    budget_type TEXT,  -- 'daily', 'lifetime'
    bid_strategy TEXT,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    api_version TEXT DEFAULT 'v21.0',
    UNIQUE(organization_id, account_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_campaigns_org ON facebook_campaigns(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facebook_campaigns_status ON facebook_campaigns(organization_id, campaign_status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS facebook_ad_sets (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES facebook_campaigns(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_set_id TEXT NOT NULL,
    ad_set_name TEXT NOT NULL,
    ad_set_status TEXT NOT NULL CHECK (ad_set_status IN ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED')),
    daily_budget_cents INTEGER,
    lifetime_budget_cents INTEGER,
    bid_amount_cents INTEGER,
    billing_event TEXT,
    optimization_goal TEXT,
    targeting TEXT,  -- JSON blob
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    UNIQUE(organization_id, account_id, campaign_id, ad_set_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_ad_sets_org ON facebook_ad_sets(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facebook_ad_sets_campaign ON facebook_ad_sets(campaign_ref) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS facebook_ads (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES facebook_campaigns(id) ON DELETE CASCADE,
    ad_set_ref TEXT NOT NULL REFERENCES facebook_ad_sets(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_set_id TEXT NOT NULL,
    ad_id TEXT NOT NULL,
    ad_name TEXT,
    ad_status TEXT NOT NULL CHECK (ad_status IN ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED')),
    creative_id TEXT,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    UNIQUE(organization_id, account_id, campaign_id, ad_set_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_facebook_ads_org ON facebook_ads(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facebook_ads_ad_set ON facebook_ads(ad_set_ref) WHERE deleted_at IS NULL;

-- Facebook Metrics Tables
CREATE TABLE IF NOT EXISTS facebook_campaign_metrics (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES facebook_campaigns(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    reach INTEGER DEFAULT 0,
    frequency REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, campaign_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_facebook_campaign_metrics_org_date ON facebook_campaign_metrics(organization_id, metric_date);

CREATE TABLE IF NOT EXISTS facebook_ad_set_metrics (
    id TEXT PRIMARY KEY,
    ad_set_ref TEXT NOT NULL REFERENCES facebook_ad_sets(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, ad_set_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_facebook_ad_set_metrics_org_date ON facebook_ad_set_metrics(organization_id, metric_date);

CREATE TABLE IF NOT EXISTS facebook_ad_metrics (
    id TEXT PRIMARY KEY,
    ad_ref TEXT NOT NULL REFERENCES facebook_ads(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, ad_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_facebook_ad_metrics_org_date ON facebook_ad_metrics(organization_id, metric_date);

-- ============================================================================
-- TIKTOK ADS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS tiktok_campaigns (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    advertiser_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT NOT NULL,
    campaign_status TEXT NOT NULL,
    objective_type TEXT,
    budget_cents INTEGER,
    budget_mode TEXT,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    UNIQUE(organization_id, advertiser_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_campaigns_org ON tiktok_campaigns(organization_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tiktok_ad_groups (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES tiktok_campaigns(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    advertiser_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_group_id TEXT NOT NULL,
    ad_group_name TEXT NOT NULL,
    ad_group_status TEXT NOT NULL,
    budget_cents INTEGER,
    bid_cents INTEGER,
    billing_event TEXT,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    UNIQUE(organization_id, advertiser_id, campaign_id, ad_group_id)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_ad_groups_org ON tiktok_ad_groups(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tiktok_ad_groups_campaign ON tiktok_ad_groups(campaign_ref) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tiktok_ads (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES tiktok_campaigns(id) ON DELETE CASCADE,
    ad_group_ref TEXT NOT NULL REFERENCES tiktok_ad_groups(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    advertiser_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_group_id TEXT NOT NULL,
    ad_id TEXT NOT NULL,
    ad_name TEXT,
    ad_status TEXT NOT NULL,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT,
    last_synced_at TEXT,
    UNIQUE(organization_id, advertiser_id, campaign_id, ad_group_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_ads_org ON tiktok_ads(organization_id) WHERE deleted_at IS NULL;

-- TikTok Metrics
CREATE TABLE IF NOT EXISTS tiktok_campaign_metrics (
    id TEXT PRIMARY KEY,
    campaign_ref TEXT NOT NULL REFERENCES tiktok_campaigns(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    video_views INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, campaign_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_campaign_metrics_org_date ON tiktok_campaign_metrics(organization_id, metric_date);

CREATE TABLE IF NOT EXISTS tiktok_ad_group_metrics (
    id TEXT PRIMARY KEY,
    ad_group_ref TEXT NOT NULL REFERENCES tiktok_ad_groups(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, ad_group_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_ad_group_metrics_org_date ON tiktok_ad_group_metrics(organization_id, metric_date);

CREATE TABLE IF NOT EXISTS tiktok_ad_metrics (
    id TEXT PRIMARY KEY,
    ad_ref TEXT NOT NULL REFERENCES tiktok_ads(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    metric_date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    spend_cents INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    conversion_value_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, ad_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_ad_metrics_org_date ON tiktok_ad_metrics(organization_id, metric_date);

-- ============================================================================
-- STRIPE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS stripe_customers (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    stripe_customer_id TEXT NOT NULL,
    email TEXT,
    name TEXT,
    metadata TEXT,  -- JSON
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, stripe_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_customers_org ON stripe_customers(organization_id);

CREATE TABLE IF NOT EXISTS stripe_charges (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    stripe_charge_id TEXT NOT NULL,
    customer_ref TEXT REFERENCES stripe_customers(id),
    stripe_customer_id TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL,
    description TEXT,
    metadata TEXT,  -- JSON
    receipt_url TEXT,
    charge_created_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, stripe_charge_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_charges_org ON stripe_charges(organization_id);
CREATE INDEX IF NOT EXISTS idx_stripe_charges_date ON stripe_charges(organization_id, charge_created_at);
CREATE INDEX IF NOT EXISTS idx_stripe_charges_customer ON stripe_charges(customer_ref);

CREATE TABLE IF NOT EXISTS stripe_subscriptions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    stripe_subscription_id TEXT NOT NULL,
    customer_ref TEXT REFERENCES stripe_customers(id),
    stripe_customer_id TEXT,
    status TEXT NOT NULL,
    current_period_start TEXT,
    current_period_end TEXT,
    cancel_at_period_end INTEGER DEFAULT 0,
    amount_cents INTEGER,
    currency TEXT DEFAULT 'usd',
    interval_type TEXT,  -- 'month', 'year'
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(organization_id, stripe_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_org ON stripe_subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_status ON stripe_subscriptions(organization_id, status);
