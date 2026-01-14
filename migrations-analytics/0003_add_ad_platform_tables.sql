-- ============================================================================
-- MIGRATION: Add Ad Platform Tables to D1 ANALYTICS_DB
-- ============================================================================
-- Replaces Supabase schemas: google_ads, facebook_ads, tiktok_ads, stripe
-- All monetary values stored in cents (INTEGER)
-- ============================================================================

-- ============================================================================
-- GOOGLE ADS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS google_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  campaign_status TEXT NOT NULL,
  campaign_type TEXT,
  budget_amount_cents INTEGER,
  budget_type TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, customer_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_gc_org ON google_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_gc_org_customer ON google_campaigns(organization_id, customer_id);

CREATE TABLE IF NOT EXISTS google_ad_groups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT NOT NULL,
  ad_group_status TEXT NOT NULL,
  ad_group_type TEXT,
  cpc_bid_cents INTEGER,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, customer_id, campaign_id, ad_group_id)
);

CREATE INDEX IF NOT EXISTS idx_gag_org ON google_ad_groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_gag_campaign ON google_ad_groups(campaign_ref);

CREATE TABLE IF NOT EXISTS google_ads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  ad_group_ref TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  ad_status TEXT NOT NULL,
  ad_type TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, customer_id, campaign_id, ad_group_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_ga_org ON google_ads(organization_id);
CREATE INDEX IF NOT EXISTS idx_ga_ad_group ON google_ads(ad_group_ref);

CREATE TABLE IF NOT EXISTS google_campaign_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, campaign_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_gcdm_org_date ON google_campaign_daily_metrics(organization_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_gcdm_campaign ON google_campaign_daily_metrics(campaign_ref, metric_date DESC);

CREATE TABLE IF NOT EXISTS google_ad_group_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  ad_group_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, ad_group_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_gagdm_org_date ON google_ad_group_daily_metrics(organization_id, metric_date DESC);

CREATE TABLE IF NOT EXISTS google_ad_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  ad_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, ad_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_gadm_org_date ON google_ad_daily_metrics(organization_id, metric_date DESC);

-- ============================================================================
-- FACEBOOK ADS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS facebook_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  campaign_status TEXT NOT NULL,
  objective TEXT,
  daily_budget_cents INTEGER,
  lifetime_budget_cents INTEGER,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, account_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_fc_org ON facebook_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_fc_org_account ON facebook_campaigns(organization_id, account_id);

CREATE TABLE IF NOT EXISTS facebook_ad_sets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_set_id TEXT NOT NULL,
  ad_set_name TEXT NOT NULL,
  ad_set_status TEXT NOT NULL,
  optimization_goal TEXT,
  billing_event TEXT,
  daily_budget_cents INTEGER,
  lifetime_budget_cents INTEGER,
  bid_amount_cents INTEGER,
  targeting TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, account_id, campaign_id, ad_set_id)
);

CREATE INDEX IF NOT EXISTS idx_fas_org ON facebook_ad_sets(organization_id);
CREATE INDEX IF NOT EXISTS idx_fas_campaign ON facebook_ad_sets(campaign_ref);

CREATE TABLE IF NOT EXISTS facebook_ads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  ad_set_ref TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_set_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  ad_status TEXT NOT NULL,
  creative_id TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, account_id, campaign_id, ad_set_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_fa_org ON facebook_ads(organization_id);
CREATE INDEX IF NOT EXISTS idx_fa_ad_set ON facebook_ads(ad_set_ref);

CREATE TABLE IF NOT EXISTS facebook_campaign_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  frequency REAL DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, campaign_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_fcdm_org_date ON facebook_campaign_daily_metrics(organization_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_fcdm_campaign ON facebook_campaign_daily_metrics(campaign_ref, metric_date DESC);

CREATE TABLE IF NOT EXISTS facebook_ad_set_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  ad_set_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  frequency REAL DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, ad_set_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_fasdm_org_date ON facebook_ad_set_daily_metrics(organization_id, metric_date DESC);

CREATE TABLE IF NOT EXISTS facebook_ad_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  ad_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  frequency REAL DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, ad_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_fadm_org_date ON facebook_ad_daily_metrics(organization_id, metric_date DESC);

-- ============================================================================
-- TIKTOK ADS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS tiktok_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  advertiser_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  campaign_status TEXT NOT NULL,
  objective TEXT,
  budget_mode TEXT,
  budget_cents INTEGER,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, advertiser_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_tc_org ON tiktok_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_tc_org_advertiser ON tiktok_campaigns(organization_id, advertiser_id);

CREATE TABLE IF NOT EXISTS tiktok_ad_groups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  advertiser_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT NOT NULL,
  ad_group_status TEXT NOT NULL,
  optimization_goal TEXT,
  bid_type TEXT,
  bid_cents INTEGER,
  budget_cents INTEGER,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, advertiser_id, campaign_id, ad_group_id)
);

CREATE INDEX IF NOT EXISTS idx_tag_org ON tiktok_ad_groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_tag_campaign ON tiktok_ad_groups(campaign_ref);

CREATE TABLE IF NOT EXISTS tiktok_ads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  ad_group_ref TEXT NOT NULL,
  advertiser_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  ad_status TEXT NOT NULL,
  landing_page_url TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, advertiser_id, campaign_id, ad_group_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_ta_org ON tiktok_ads(organization_id);
CREATE INDEX IF NOT EXISTS idx_ta_ad_group ON tiktok_ads(ad_group_ref);

CREATE TABLE IF NOT EXISTS tiktok_campaign_daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  video_views INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, campaign_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_tcdm_org_date ON tiktok_campaign_daily_metrics(organization_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_tcdm_campaign ON tiktok_campaign_daily_metrics(campaign_ref, metric_date DESC);

-- ============================================================================
-- STRIPE TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS stripe_charges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  customer_id TEXT,
  customer_email_hash TEXT,
  has_invoice INTEGER DEFAULT 0,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_method_type TEXT,
  stripe_created_at TEXT NOT NULL,
  metadata TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, charge_id)
);

CREATE INDEX IF NOT EXISTS idx_sc_org ON stripe_charges(organization_id);
CREATE INDEX IF NOT EXISTS idx_sc_org_date ON stripe_charges(organization_id, stripe_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sc_customer ON stripe_charges(organization_id, customer_email_hash);

CREATE TABLE IF NOT EXISTS stripe_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  total_charges INTEGER DEFAULT 0,
  total_amount_cents INTEGER DEFAULT 0,
  successful_charges INTEGER DEFAULT 0,
  failed_charges INTEGER DEFAULT 0,
  refunded_amount_cents INTEGER DEFAULT 0,
  unique_customers INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_sds_org_date ON stripe_daily_summary(organization_id, summary_date DESC);

-- ============================================================================
-- SYNC TRACKING
-- ============================================================================

-- Add connector-specific watermarks
CREATE TABLE IF NOT EXISTS connector_sync_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  connector_type TEXT NOT NULL, -- 'google_ads', 'facebook_ads', 'tiktok_ads', 'stripe'
  account_id TEXT NOT NULL,     -- Platform-specific account ID
  last_sync_at TEXT,
  last_sync_status TEXT,        -- 'success', 'failed', 'in_progress'
  records_synced INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connector_type, account_id)
);

CREATE INDEX IF NOT EXISTS idx_css_org ON connector_sync_status(organization_id);
CREATE INDEX IF NOT EXISTS idx_css_type ON connector_sync_status(connector_type);
