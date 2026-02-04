-- ============================================================================
-- SHARD SCHEMA: Unified Ad Platform Tables
-- ============================================================================
-- Aligns shard schema with ANALYTICS_DB unified architecture.
-- Replaces platform-specific tables (google_campaigns, facebook_campaigns, etc.)
-- with unified tables that support 100+ connectors.
--
-- Key design decisions:
-- - platform column identifies source (google, facebook, tiktok, linkedin, etc.)
-- - platform_fields JSON stores platform-specific structured data
-- - All monetary values stored in cents (INTEGER)
-- - Same schema as migrations-analytics/0019_unified_ad_tables.sql
-- ============================================================================

-- ============================================================================
-- UNIFIED AD CAMPAIGNS
-- ============================================================================

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,              -- 'google', 'facebook', 'tiktok', 'linkedin', etc.
  account_id TEXT NOT NULL,            -- customer_id/account_id/advertiser_id
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  campaign_status TEXT NOT NULL,       -- Normalized: 'active', 'paused', 'archived', 'deleted'
  objective TEXT,                      -- Campaign objective/type
  budget_cents INTEGER,                -- Budget amount in cents
  budget_type TEXT,                    -- 'daily', 'lifetime', 'unlimited'
  platform_fields TEXT,                -- JSON: platform-specific structured data
  raw_data TEXT,                       -- Full API response for debugging
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, account_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_adc_org ON ad_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_adc_org_platform ON ad_campaigns(organization_id, platform);
CREATE INDEX IF NOT EXISTS idx_adc_org_platform_account ON ad_campaigns(organization_id, platform, account_id);
CREATE INDEX IF NOT EXISTS idx_adc_status ON ad_campaigns(organization_id, campaign_status);

-- ============================================================================
-- UNIFIED AD GROUPS
-- ============================================================================

CREATE TABLE IF NOT EXISTS ad_groups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,          -- References ad_campaigns.id (internal ref)
  campaign_id TEXT NOT NULL,           -- Denormalized platform campaign ID for queries
  ad_group_id TEXT NOT NULL,           -- ad_group_id/ad_set_id depending on platform
  ad_group_name TEXT NOT NULL,
  ad_group_status TEXT NOT NULL,       -- Normalized: 'active', 'paused', 'archived', 'deleted'
  bid_amount_cents INTEGER,            -- Bid amount in cents
  bid_type TEXT,                       -- 'cpc', 'cpm', 'cpa', etc.
  platform_fields TEXT,                -- JSON: targeting, optimization_goal, billing_event, etc.
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, account_id, campaign_id, ad_group_id)
);

CREATE INDEX IF NOT EXISTS idx_adg_org ON ad_groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_adg_org_platform ON ad_groups(organization_id, platform);
CREATE INDEX IF NOT EXISTS idx_adg_campaign_ref ON ad_groups(campaign_ref);
CREATE INDEX IF NOT EXISTS idx_adg_status ON ad_groups(organization_id, ad_group_status);

-- ============================================================================
-- UNIFIED ADS
-- ============================================================================

CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,          -- References ad_campaigns.id
  ad_group_ref TEXT NOT NULL,          -- References ad_groups.id
  campaign_id TEXT NOT NULL,           -- Denormalized for queries
  ad_group_id TEXT NOT NULL,           -- Denormalized for queries
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  ad_status TEXT NOT NULL,             -- Normalized: 'active', 'paused', 'archived', 'deleted'
  ad_type TEXT,                        -- 'image', 'video', 'carousel', 'responsive', 'text'
  headline TEXT,                       -- Primary headline/title
  landing_url TEXT,                    -- Final URL / landing page
  platform_fields TEXT,                -- JSON: creative_id, display_url, descriptions, etc.
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, account_id, ad_group_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_org ON ads(organization_id);
CREATE INDEX IF NOT EXISTS idx_ads_org_platform ON ads(organization_id, platform);
CREATE INDEX IF NOT EXISTS idx_ads_ad_group_ref ON ads(ad_group_ref);
CREATE INDEX IF NOT EXISTS idx_ads_campaign_ref ON ads(campaign_ref);
CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(organization_id, ad_status);

-- ============================================================================
-- UNIFIED AD METRICS
-- ============================================================================
-- Single table for all entity types (campaign, ad_group, ad) and all platforms.

CREATE TABLE IF NOT EXISTS ad_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  entity_type TEXT NOT NULL,           -- 'campaign', 'ad_group', 'ad'
  entity_ref TEXT NOT NULL,            -- References appropriate table's id
  metric_date TEXT NOT NULL,           -- YYYY-MM-DD
  -- Core metrics (present on all platforms)
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  -- Calculated metrics
  ctr REAL DEFAULT 0,                  -- clicks / impressions
  cpc_cents INTEGER DEFAULT 0,         -- spend / clicks
  cpm_cents INTEGER DEFAULT 0,         -- (spend / impressions) * 1000
  -- Platform-specific metrics stored as JSON
  extra_metrics TEXT,                  -- JSON: reach, frequency, video_views, engagement, etc.
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, entity_type, entity_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_adm_org_date ON ad_metrics(organization_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_adm_org_platform_date ON ad_metrics(organization_id, platform, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_adm_entity ON ad_metrics(entity_ref, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_adm_org_type_date ON ad_metrics(organization_id, entity_type, metric_date DESC);
