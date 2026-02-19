-- ============================================================================
-- MIGRATION 0005: UTM, Tracking Links, and Reconciliation Tables
-- ============================================================================
-- Adds UTM campaign performance, tracking link analytics, and platform
-- reconciliation tables to D1 ANALYTICS_DB.
-- ============================================================================

-- ============================================================================
-- UTM PERFORMANCE
-- Tracks performance of UTM-tagged campaigns
-- ============================================================================

-- Daily UTM campaign performance
CREATE TABLE IF NOT EXISTS utm_daily_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_date TEXT NOT NULL, -- YYYY-MM-DD

  -- UTM dimensions (all nullable - represents different aggregation levels)
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,

  -- Traffic metrics
  clicks INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  unique_visitors INTEGER DEFAULT 0,
  unique_sessions INTEGER DEFAULT 0,
  bounce_count INTEGER DEFAULT 0,
  total_session_duration_seconds INTEGER DEFAULT 0,

  -- Conversion metrics
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  assisted_conversions INTEGER DEFAULT 0, -- Touchpoint in path but not last

  -- Engagement metrics
  form_submissions INTEGER DEFAULT 0,
  video_plays INTEGER DEFAULT 0,
  scroll_depth_avg REAL, -- Average scroll depth percentage

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
);

CREATE INDEX IF NOT EXISTS idx_udp_org_date ON utm_daily_performance(organization_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_udp_source ON utm_daily_performance(organization_id, utm_source);
CREATE INDEX IF NOT EXISTS idx_udp_campaign ON utm_daily_performance(organization_id, utm_campaign);

-- ============================================================================
-- TRACKING LINK ANALYTICS
-- Performance data for email/SMS tracking links
-- ============================================================================

-- Individual tracking link click events
CREATE TABLE IF NOT EXISTS tracking_link_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  link_id TEXT NOT NULL, -- References tracking_links.id in main DB

  -- Click details
  anonymous_id TEXT,
  session_id TEXT,
  user_id TEXT, -- If identified

  -- Context
  referrer_url TEXT,
  landing_url TEXT, -- Final destination after redirect

  -- Device/Location
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  region TEXT,
  city TEXT,

  -- Timing
  click_timestamp TEXT NOT NULL,

  -- Conversion tracking
  converted INTEGER DEFAULT 0,
  conversion_id TEXT, -- If this click led to conversion
  conversion_value_cents INTEGER,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tlc_link ON tracking_link_clicks(link_id, click_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tlc_org ON tracking_link_clicks(organization_id, click_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tlc_anon ON tracking_link_clicks(anonymous_id);
CREATE INDEX IF NOT EXISTS idx_tlc_converted ON tracking_link_clicks(link_id, converted);

-- Daily tracking link performance summary
CREATE TABLE IF NOT EXISTS tracking_link_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  summary_date TEXT NOT NULL, -- YYYY-MM-DD

  -- Click metrics
  total_clicks INTEGER DEFAULT 0,
  unique_clicks INTEGER DEFAULT 0, -- Unique anonymous_ids

  -- Device breakdown
  desktop_clicks INTEGER DEFAULT 0,
  mobile_clicks INTEGER DEFAULT 0,
  tablet_clicks INTEGER DEFAULT 0,

  -- Conversion metrics
  conversions INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  conversion_rate REAL, -- conversions / unique_clicks

  -- Geographic (top country)
  top_country TEXT,
  top_country_clicks INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, link_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_tlds_org_date ON tracking_link_daily_summary(organization_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_tlds_link ON tracking_link_daily_summary(link_id, summary_date DESC);

-- ============================================================================
-- PLATFORM RECONCILIATION
-- Compares ad platform claims vs verified conversions
-- ============================================================================

-- What ad platforms claim as conversions (from their APIs)
CREATE TABLE IF NOT EXISTS platform_conversion_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- Platform details
  platform TEXT NOT NULL, -- 'google', 'facebook', 'tiktok', 'microsoft', 'linkedin'
  account_id TEXT NOT NULL, -- Platform account ID
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT,
  ad_id TEXT,

  -- Claim details
  claim_date TEXT NOT NULL, -- Date the conversion was claimed
  conversion_action TEXT, -- Platform's conversion action name
  claimed_conversions REAL DEFAULT 0, -- Can be fractional (data-driven attribution)
  claimed_value_cents INTEGER DEFAULT 0,
  claimed_currency TEXT DEFAULT 'USD',

  -- Click ID for matching
  click_id TEXT,
  click_id_type TEXT,

  -- Our matching results
  matched_conversion_id TEXT, -- Our conversion record if matched
  match_status TEXT DEFAULT 'pending', -- 'matched', 'unmatched', 'partial', 'pending'
  match_confidence REAL, -- 0-100 confidence score
  match_method TEXT, -- 'click_id', 'email', 'timestamp', 'value'

  -- Verified values (from our records)
  verified_conversions INTEGER DEFAULT 0,
  verified_value_cents INTEGER DEFAULT 0,

  -- Discrepancy
  conversion_discrepancy REAL, -- claimed - verified
  value_discrepancy_cents INTEGER, -- claimed_value - verified_value

  -- Metadata
  raw_claim_data TEXT, -- JSON of original platform claim
  synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pcc_org_date ON platform_conversion_claims(organization_id, claim_date DESC);
CREATE INDEX IF NOT EXISTS idx_pcc_platform ON platform_conversion_claims(organization_id, platform);
CREATE INDEX IF NOT EXISTS idx_pcc_campaign ON platform_conversion_claims(organization_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_pcc_click ON platform_conversion_claims(click_id);
CREATE INDEX IF NOT EXISTS idx_pcc_status ON platform_conversion_claims(organization_id, match_status);

-- Daily reconciliation summary
CREATE TABLE IF NOT EXISTS reconciliation_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_date TEXT NOT NULL, -- YYYY-MM-DD
  platform TEXT NOT NULL,

  -- Claim totals
  total_claims INTEGER DEFAULT 0,
  claimed_conversions REAL DEFAULT 0,
  claimed_value_cents INTEGER DEFAULT 0,

  -- Match results
  matched_claims INTEGER DEFAULT 0,
  unmatched_claims INTEGER DEFAULT 0,
  partial_matches INTEGER DEFAULT 0,

  -- Verified totals
  verified_conversions INTEGER DEFAULT 0,
  verified_value_cents INTEGER DEFAULT 0,

  -- Discrepancies
  conversion_discrepancy REAL DEFAULT 0, -- Sum of discrepancies
  value_discrepancy_cents INTEGER DEFAULT 0,
  discrepancy_rate REAL, -- |discrepancy| / claimed as percentage

  -- ROAS comparison
  claimed_roas REAL, -- Platform-reported ROAS
  actual_roas REAL, -- Verified ROAS
  roas_inflation_percent REAL, -- How much platform overstates

  -- Ad spend (for ROAS calculation)
  ad_spend_cents INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, platform)
);

CREATE INDEX IF NOT EXISTS idx_rds_org_date ON reconciliation_daily_summary(organization_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_rds_platform ON reconciliation_daily_summary(organization_id, platform);

-- ============================================================================
-- JOURNEY TOUCHPOINTS
-- Tracks user journey across touchpoints for path analysis
-- ============================================================================

CREATE TABLE IF NOT EXISTS journey_touchpoints (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- Identity
  anonymous_id TEXT NOT NULL,
  user_id TEXT, -- If identified
  session_id TEXT,

  -- Touchpoint details
  touchpoint_type TEXT NOT NULL, -- 'page_view', 'ad_click', 'email_click', 'form_submit', 'conversion'
  touchpoint_source TEXT, -- 'google', 'facebook', 'email', 'organic', 'direct'
  touchpoint_timestamp TEXT NOT NULL,

  -- Source details
  campaign_id TEXT,
  ad_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,

  -- Page context
  page_url TEXT,
  page_path TEXT,
  page_title TEXT,
  referrer_url TEXT,

  -- Conversion details (if type = 'conversion')
  conversion_id TEXT,
  conversion_value_cents INTEGER,

  -- Sequence
  touchpoint_number INTEGER, -- Position in this user's journey
  is_first_touch INTEGER DEFAULT 0,
  is_last_touch INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jt_anon ON journey_touchpoints(anonymous_id, touchpoint_timestamp);
CREATE INDEX IF NOT EXISTS idx_jt_user ON journey_touchpoints(user_id, touchpoint_timestamp);
CREATE INDEX IF NOT EXISTS idx_jt_session ON journey_touchpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_jt_org_date ON journey_touchpoints(organization_id, touchpoint_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_jt_conv ON journey_touchpoints(conversion_id);
