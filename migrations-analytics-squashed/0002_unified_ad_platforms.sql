-- Grouped migration: unified_ad_platforms
-- Tables: ad_campaigns, ad_groups, ads, ad_metrics

-- Table: ad_campaigns
CREATE TABLE ad_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  campaign_status TEXT NOT NULL,
  objective TEXT,
  budget_cents INTEGER,
  budget_type TEXT,
  platform_fields TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, account_id, campaign_id)
);

-- Indexes for ad_campaigns
CREATE INDEX idx_adc_org ON ad_campaigns(organization_id);
CREATE INDEX idx_adc_org_platform ON ad_campaigns(organization_id, platform);
CREATE INDEX idx_adc_org_platform_account ON ad_campaigns(organization_id, platform, account_id);
CREATE INDEX idx_adc_status ON ad_campaigns(organization_id, campaign_status);

-- Table: ad_groups
CREATE TABLE ad_groups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT NOT NULL,
  ad_group_status TEXT NOT NULL,
  bid_amount_cents INTEGER,
  bid_type TEXT,
  platform_fields TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, account_id, campaign_id, ad_group_id)
);

-- Indexes for ad_groups
CREATE INDEX idx_adg_campaign_ref ON ad_groups(campaign_ref);
CREATE INDEX idx_adg_org ON ad_groups(organization_id);
CREATE INDEX idx_adg_org_platform ON ad_groups(organization_id, platform);
CREATE INDEX idx_adg_status ON ad_groups(organization_id, ad_group_status);

-- Table: ads
CREATE TABLE ads (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  ad_group_ref TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  ad_status TEXT NOT NULL,
  ad_type TEXT,
  headline TEXT,
  landing_url TEXT,
  platform_fields TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, platform, account_id, ad_group_id, ad_id)
);

-- Indexes for ads
CREATE INDEX idx_ads_ad_group_ref ON ads(ad_group_ref);
CREATE INDEX idx_ads_campaign_ref ON ads(campaign_ref);
CREATE INDEX idx_ads_org ON ads(organization_id);
CREATE INDEX idx_ads_org_platform ON ads(organization_id, platform);
CREATE INDEX idx_ads_status ON ads(organization_id, ad_status);

-- Table: ad_metrics
CREATE TABLE ad_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend_cents INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  ctr REAL DEFAULT 0,
  cpc_cents INTEGER DEFAULT 0,
  cpm_cents INTEGER DEFAULT 0,
  extra_metrics TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(organization_id, platform, entity_type, entity_ref, metric_date)
);

-- Indexes for ad_metrics
CREATE INDEX idx_adm_entity ON ad_metrics(entity_ref, metric_date DESC);
CREATE INDEX idx_adm_org_date ON ad_metrics(organization_id, metric_date DESC);
CREATE INDEX idx_adm_org_platform_date ON ad_metrics(organization_id, platform, metric_date DESC);
CREATE INDEX idx_adm_org_type_date ON ad_metrics(organization_id, entity_type, metric_date DESC);
