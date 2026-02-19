-- Unified Mobile Attribution Tables
-- Supports: AppsFlyer, Adjust, Branch, Singular, Kochava

CREATE TABLE IF NOT EXISTS attribution_installs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  app_name TEXT,
  app_version TEXT,
  device_id TEXT,                      -- Hashed device identifier
  advertising_id TEXT,                 -- Hashed IDFA/GAID
  customer_user_id TEXT,               -- App's internal user ID
  install_type TEXT,                   -- 'organic', 'non_organic', 'reinstall'
  attribution_type TEXT,               -- 'click', 'impression', 'unknown'
  media_source TEXT,                   -- Ad network name
  campaign_name TEXT,
  campaign_id TEXT,
  adset_name TEXT,
  adset_id TEXT,
  ad_name TEXT,
  ad_id TEXT,
  channel TEXT,
  keywords TEXT,
  cost_cents INTEGER,
  cost_currency TEXT DEFAULT 'USD',
  click_time TEXT,
  impression_time TEXT,
  install_time TEXT NOT NULL,
  is_retargeting INTEGER DEFAULT 0,
  is_primary_attribution INTEGER DEFAULT 1,
  country TEXT,
  region TEXT,
  city TEXT,
  ip_hash TEXT,
  device_type TEXT,                    -- 'phone', 'tablet'
  device_model TEXT,
  os_name TEXT,                        -- 'ios', 'android'
  os_version TEXT,
  sdk_version TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS attribution_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT,
  install_ref TEXT,
  install_external_id TEXT,
  app_id TEXT NOT NULL,
  device_id TEXT,
  customer_user_id TEXT,
  event_name TEXT NOT NULL,
  event_category TEXT,
  event_value REAL,
  event_value_currency TEXT DEFAULT 'USD',
  revenue_cents INTEGER,
  revenue_currency TEXT DEFAULT 'USD',
  is_first_event INTEGER DEFAULT 0,
  media_source TEXT,
  campaign_name TEXT,
  campaign_id TEXT,
  adset_name TEXT,
  adset_id TEXT,
  country TEXT,
  device_type TEXT,
  os_name TEXT,
  os_version TEXT,
  app_version TEXT,
  event_properties TEXT,               -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  occurred_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attribution_revenue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT,
  install_ref TEXT,
  install_external_id TEXT,
  app_id TEXT NOT NULL,
  device_id TEXT,
  customer_user_id TEXT,
  revenue_type TEXT NOT NULL,          -- 'purchase', 'subscription', 'ad_revenue', 'iap'
  product_id TEXT,
  product_name TEXT,
  quantity INTEGER DEFAULT 1,
  revenue_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  is_validated INTEGER,                -- Receipt validation status
  media_source TEXT,
  campaign_name TEXT,
  campaign_id TEXT,
  country TEXT,
  device_type TEXT,
  os_name TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  occurred_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attribution_cohorts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  app_id TEXT NOT NULL,
  cohort_date TEXT NOT NULL,           -- Install date (YYYY-MM-DD)
  media_source TEXT,
  campaign_name TEXT,
  campaign_id TEXT,
  country TEXT,
  install_count INTEGER DEFAULT 0,
  day_0_users INTEGER DEFAULT 0,
  day_1_users INTEGER DEFAULT 0,
  day_3_users INTEGER DEFAULT 0,
  day_7_users INTEGER DEFAULT 0,
  day_14_users INTEGER DEFAULT 0,
  day_30_users INTEGER DEFAULT 0,
  day_60_users INTEGER DEFAULT 0,
  day_90_users INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  day_0_revenue_cents INTEGER DEFAULT 0,
  day_7_revenue_cents INTEGER DEFAULT 0,
  day_30_revenue_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, app_id, cohort_date, media_source, campaign_id, country)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_attribution_installs_org ON attribution_installs(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_attribution_installs_date ON attribution_installs(organization_id, install_time);
CREATE INDEX IF NOT EXISTS idx_attribution_installs_source ON attribution_installs(organization_id, media_source);
CREATE INDEX IF NOT EXISTS idx_attribution_events_org ON attribution_events(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_attribution_events_date ON attribution_events(organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_attribution_events_name ON attribution_events(organization_id, event_name);
CREATE INDEX IF NOT EXISTS idx_attribution_revenue_org ON attribution_revenue(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_attribution_revenue_date ON attribution_revenue(organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_attribution_cohorts_org ON attribution_cohorts(organization_id, source_platform);
