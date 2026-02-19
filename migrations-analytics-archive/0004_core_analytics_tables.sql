-- ============================================================================
-- MIGRATION 0004: Core Analytics Tables
-- ============================================================================
-- Adds conversion tracking, event aggregates, goal metrics, attribution,
-- click tracking, and domain claims tables to D1 ANALYTICS_DB.
-- ============================================================================

-- ============================================================================
-- CONVERSION TABLES
-- Core tables tracking actual business outcomes from all sources
-- ============================================================================

-- Individual conversion records (unified across all sources)
CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- Source identification
  conversion_source TEXT NOT NULL, -- 'stripe', 'shopify', 'jobber', 'tag', 'platform'
  source_id TEXT, -- stripe_charge_id, shopify_order_id, jobber_job_id, etc.
  source_platform TEXT, -- For platform-reported: 'google', 'facebook', 'tiktok'

  -- Attribution (which ad/campaign gets credit)
  attributed_platform TEXT, -- 'google', 'facebook', 'tiktok', 'organic', 'direct', 'email'
  attributed_campaign_id TEXT,
  attributed_ad_group_id TEXT,
  attributed_ad_id TEXT,
  attribution_model TEXT, -- 'first_touch', 'last_touch', 'linear', etc.

  -- Click tracking
  click_id TEXT, -- gclid, fbclid, ttclid, etc.
  click_id_type TEXT, -- 'gclid', 'fbclid', 'ttclid', 'custom'

  -- Value
  value_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',

  -- Identity (for matching/deduplication)
  customer_id TEXT, -- Platform customer ID
  customer_email_hash TEXT, -- SHA256 of lowercase email
  anonymous_id TEXT, -- Our tracking anonymous ID

  -- UTM parameters (captured at conversion or from attributed click)
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,

  -- Timing
  conversion_timestamp TEXT NOT NULL,
  click_timestamp TEXT, -- When the attributed click happened

  -- Metadata
  raw_data TEXT, -- JSON of original conversion data
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_org_date ON conversions(organization_id, conversion_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conv_source ON conversions(organization_id, conversion_source);
CREATE INDEX IF NOT EXISTS idx_conv_platform ON conversions(organization_id, attributed_platform);
CREATE INDEX IF NOT EXISTS idx_conv_click_id ON conversions(click_id);
CREATE INDEX IF NOT EXISTS idx_conv_email ON conversions(organization_id, customer_email_hash);
CREATE INDEX IF NOT EXISTS idx_conv_anon ON conversions(organization_id, anonymous_id);

-- Daily conversion aggregates (pre-computed for fast dashboard queries)
CREATE TABLE IF NOT EXISTS conversion_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_date TEXT NOT NULL, -- YYYY-MM-DD

  -- Dimensions
  conversion_source TEXT NOT NULL, -- 'stripe', 'shopify', 'jobber', 'tag', 'platform'
  attributed_platform TEXT, -- 'google', 'facebook', 'tiktok', 'organic', etc. (NULL for all)

  -- Metrics
  conversion_count INTEGER DEFAULT 0,
  total_value_cents INTEGER DEFAULT 0,
  unique_customers INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, conversion_source, attributed_platform)
);

CREATE INDEX IF NOT EXISTS idx_cds_org_date ON conversion_daily_summary(organization_id, summary_date DESC);

-- ============================================================================
-- EVENT AGGREGATES
-- Pre-computed from R2 SQL for fast dashboard queries
-- ============================================================================

-- Daily event summary by type
CREATE TABLE IF NOT EXISTS event_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  org_tag TEXT NOT NULL,
  summary_date TEXT NOT NULL, -- YYYY-MM-DD
  event_type TEXT NOT NULL, -- 'page_view', 'conversion', 'click', 'form_submit', 'identify', etc.

  -- Metrics
  event_count INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0, -- Unique anonymous_ids
  unique_sessions INTEGER DEFAULT 0, -- Unique session_ids

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, event_type)
);

CREATE INDEX IF NOT EXISTS idx_eds_org_date ON event_daily_summary(organization_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_eds_org_tag ON event_daily_summary(org_tag, summary_date DESC);

-- Hourly event summary (for real-time dashboards, optional - can be computed on-demand)
CREATE TABLE IF NOT EXISTS event_hourly_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_hour TEXT NOT NULL, -- ISO timestamp truncated to hour: '2025-01-14T15:00:00Z'
  event_type TEXT NOT NULL,

  event_count INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_hour, event_type)
);

CREATE INDEX IF NOT EXISTS idx_ehs_org_hour ON event_hourly_summary(organization_id, summary_hour DESC);

-- ============================================================================
-- GOAL METRICS
-- Tracks performance against defined conversion goals
-- ============================================================================

-- Daily goal performance aggregates
CREATE TABLE IF NOT EXISTS goal_metrics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  goal_id TEXT NOT NULL, -- References conversion_goals.id in main DB
  summary_date TEXT NOT NULL, -- YYYY-MM-DD

  -- Total metrics
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  conversion_rate REAL, -- Conversions / sessions (if available)

  -- Breakdown by source
  conversions_platform INTEGER DEFAULT 0, -- From ad platform APIs
  conversions_tag INTEGER DEFAULT 0, -- From our tracking tag
  conversions_connector INTEGER DEFAULT 0, -- From payment connectors (Stripe, Shopify, etc.)

  value_platform_cents INTEGER DEFAULT 0,
  value_tag_cents INTEGER DEFAULT 0,
  value_connector_cents INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, goal_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_gmd_org_date ON goal_metrics_daily(organization_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_gmd_goal ON goal_metrics_daily(goal_id, summary_date DESC);

-- Individual goal conversion events (for drill-down and debugging)
CREATE TABLE IF NOT EXISTS goal_conversions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  conversion_id TEXT, -- References conversions.id if linked

  -- Source
  conversion_source TEXT NOT NULL, -- 'platform', 'tag', 'connector'
  source_platform TEXT, -- 'google', 'facebook', 'stripe', etc.
  source_event_id TEXT, -- Platform-specific event ID

  -- Value
  value_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',

  -- Attribution
  attribution_model TEXT,
  attribution_data TEXT, -- JSON with model-specific attribution details
  attributed_campaign_id TEXT,
  attributed_ad_id TEXT,

  -- Timing
  conversion_timestamp TEXT NOT NULL,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gc_goal ON goal_conversions(goal_id, conversion_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_gc_org ON goal_conversions(organization_id, conversion_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_gc_conv ON goal_conversions(conversion_id);

-- ============================================================================
-- CONVERSION ATTRIBUTION
-- Per-conversion multi-touch attribution (distinct from channel-level attribution_results)
-- ============================================================================

-- Attribution touchpoints per conversion per model
CREATE TABLE IF NOT EXISTS conversion_attribution (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  conversion_id TEXT NOT NULL, -- References conversions.id

  -- Attribution model
  model TEXT NOT NULL, -- 'first_touch', 'last_touch', 'linear', 'time_decay', 'position_based'

  -- Credited touchpoint
  touchpoint_type TEXT NOT NULL, -- 'ad_click', 'organic_search', 'direct', 'email', 'referral'
  touchpoint_platform TEXT, -- 'google', 'facebook', 'tiktok', etc.
  touchpoint_campaign_id TEXT,
  touchpoint_ad_group_id TEXT,
  touchpoint_ad_id TEXT,
  touchpoint_timestamp TEXT,

  -- Click ID (if from paid ad)
  click_id TEXT,
  click_id_type TEXT,

  -- Credit allocation
  credit_percent REAL NOT NULL, -- 0-100, sum across touchpoints = 100
  credit_value_cents INTEGER NOT NULL, -- Portion of conversion value

  -- Position in journey
  touchpoint_position INTEGER, -- 1 = first, N = last
  total_touchpoints INTEGER,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ca_conv ON conversion_attribution(conversion_id);
CREATE INDEX IF NOT EXISTS idx_ca_org_model ON conversion_attribution(organization_id, model);
CREATE INDEX IF NOT EXISTS idx_ca_platform ON conversion_attribution(organization_id, touchpoint_platform);
CREATE INDEX IF NOT EXISTS idx_ca_campaign ON conversion_attribution(touchpoint_campaign_id);

-- ============================================================================
-- CLICK TRACKING
-- Tracks ad clicks and touchpoints for attribution
-- ============================================================================

-- Individual click/touchpoint events
CREATE TABLE IF NOT EXISTS tracked_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- Click identifiers
  click_id TEXT, -- gclid, fbclid, ttclid, etc.
  click_id_type TEXT, -- 'gclid', 'fbclid', 'ttclid', 'custom'

  -- Source
  touchpoint_type TEXT NOT NULL, -- 'ad_click', 'organic_search', 'direct', 'email', 'referral', 'social'
  platform TEXT, -- 'google', 'facebook', 'tiktok', 'bing', etc.
  campaign_id TEXT,
  ad_group_id TEXT,
  ad_id TEXT,

  -- UTM parameters
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,

  -- Landing page
  landing_url TEXT,
  landing_path TEXT, -- Just the path portion
  referrer_url TEXT,
  referrer_domain TEXT,

  -- Identity
  anonymous_id TEXT,
  session_id TEXT,
  user_id TEXT, -- If identified

  -- Device/Geo (optional, from tracking)
  device_type TEXT, -- 'desktop', 'mobile', 'tablet'
  browser TEXT,
  os TEXT,
  country TEXT,
  region TEXT,

  -- Timing
  click_timestamp TEXT NOT NULL,

  -- Conversion link
  converted INTEGER DEFAULT 0, -- 1 if this click led to conversion
  conversion_id TEXT, -- References conversions.id if converted

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tc_org_date ON tracked_clicks(organization_id, click_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tc_click_id ON tracked_clicks(click_id);
CREATE INDEX IF NOT EXISTS idx_tc_anon ON tracked_clicks(anonymous_id);
CREATE INDEX IF NOT EXISTS idx_tc_session ON tracked_clicks(session_id);
CREATE INDEX IF NOT EXISTS idx_tc_campaign ON tracked_clicks(organization_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_tc_converted ON tracked_clicks(organization_id, converted, click_timestamp DESC);

-- ============================================================================
-- DOMAIN CLAIMS
-- Associates domains with organizations for R2 SQL event queries
-- (Replaces Supabase events.domain_claims)
-- ============================================================================

CREATE TABLE IF NOT EXISTS domain_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  org_tag TEXT NOT NULL, -- Short org tag for R2 SQL queries
  domain_pattern TEXT NOT NULL, -- 'example.com' or '*.example.com'

  -- Status
  is_active INTEGER DEFAULT 1,
  claimed_at TEXT DEFAULT (datetime('now')),
  released_at TEXT,

  -- Metadata
  verified INTEGER DEFAULT 0, -- DNS verification status
  verification_token TEXT, -- TXT record value for verification

  UNIQUE(domain_pattern, org_tag)
);

CREATE INDEX IF NOT EXISTS idx_dc_org ON domain_claims(organization_id);
CREATE INDEX IF NOT EXISTS idx_dc_tag ON domain_claims(org_tag);
CREATE INDEX IF NOT EXISTS idx_dc_domain ON domain_claims(domain_pattern);
CREATE INDEX IF NOT EXISTS idx_dc_active ON domain_claims(is_active, org_tag);
