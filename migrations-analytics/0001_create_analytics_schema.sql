-- ============================================================================
-- MIGRATION: Pure Cloudflare Analytics Schema
-- ============================================================================
-- This schema replaces Supabase for analytics data storage.
-- All event data flows: R2 Datalake -> D1 Analytics -> Dashboard
-- ============================================================================

-- ============================================================================
-- TOUCHPOINTS (from R2 events via EventsSyncWorkflow)
-- ============================================================================
CREATE TABLE IF NOT EXISTS touchpoints (
  id TEXT PRIMARY KEY,
  org_tag TEXT NOT NULL,

  -- Identity
  anonymous_id TEXT NOT NULL,
  user_id_hash TEXT,
  session_id TEXT,
  device_fingerprint_id TEXT,

  -- Timestamp
  touchpoint_ts TEXT NOT NULL,

  -- Event context
  event_type TEXT NOT NULL,
  page_path TEXT,
  page_title TEXT,
  referrer_domain TEXT,

  -- Channel classification
  channel_group TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,

  -- Click IDs (platform attribution)
  gclid TEXT,
  fbclid TEXT,
  ttclid TEXT,
  msclkid TEXT,

  -- Email link attribution
  email_link_id TEXT,

  -- Device/Geo
  device_type TEXT,
  browser_name TEXT,
  geo_country TEXT,
  geo_region TEXT,
  geo_city TEXT,

  -- Conversion linkage (populated by AttributionWorkflow)
  conversion_id TEXT,
  goal_value_cents INTEGER,
  position_in_journey INTEGER,
  total_touchpoints_in_journey INTEGER,
  time_to_conversion_hours REAL,

  -- Attribution credits (populated by AttributionWorkflow)
  first_touch_credit REAL DEFAULT 0,
  last_touch_credit REAL DEFAULT 0,
  linear_credit REAL DEFAULT 0,
  time_decay_credit REAL DEFAULT 0,
  position_based_credit REAL DEFAULT 0,
  markov_credit REAL DEFAULT 0,
  shapley_credit REAL DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_tp_org_ts ON touchpoints(org_tag, touchpoint_ts DESC);
CREATE INDEX IF NOT EXISTS idx_tp_org_anon ON touchpoints(org_tag, anonymous_id);
CREATE INDEX IF NOT EXISTS idx_tp_org_user ON touchpoints(org_tag, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tp_org_session ON touchpoints(org_tag, session_id);
CREATE INDEX IF NOT EXISTS idx_tp_org_channel ON touchpoints(org_tag, channel_group);
CREATE INDEX IF NOT EXISTS idx_tp_conversion ON touchpoints(org_tag, conversion_id) WHERE conversion_id IS NOT NULL;

-- Click ID lookups (sparse indexes)
CREATE INDEX IF NOT EXISTS idx_tp_gclid ON touchpoints(gclid) WHERE gclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tp_fbclid ON touchpoints(fbclid) WHERE fbclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tp_ttclid ON touchpoints(ttclid) WHERE ttclid IS NOT NULL;

-- ============================================================================
-- CUSTOMER IDENTITIES (identity graph)
-- ============================================================================
CREATE TABLE IF NOT EXISTS customer_identities (
  id TEXT PRIMARY KEY,
  org_tag TEXT NOT NULL,

  -- Primary identifiers
  anonymous_id TEXT NOT NULL,
  user_id_hash TEXT,
  email_hash TEXT,
  device_fingerprint_id TEXT,

  -- External IDs (from revenue platforms)
  stripe_customer_id TEXT,
  shopify_customer_id TEXT,

  -- Identity confidence
  identity_method TEXT NOT NULL, -- 'anonymous', 'device_fingerprint', 'email_capture', 'login', 'signup', 'purchase'
  identity_confidence REAL DEFAULT 0.3,

  -- First touch attribution
  first_touch_source TEXT,
  first_touch_medium TEXT,
  first_touch_campaign TEXT,
  first_touch_click_id TEXT,
  first_touch_click_id_type TEXT,

  -- Timestamps
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,

  -- Aggregated metrics
  total_sessions INTEGER DEFAULT 0,
  total_touchpoints INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,

  -- Device history (JSON array)
  known_devices TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, anonymous_id)
);

CREATE INDEX IF NOT EXISTS idx_ci_org ON customer_identities(org_tag);
CREATE INDEX IF NOT EXISTS idx_ci_org_user ON customer_identities(org_tag, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_org_email ON customer_identities(org_tag, email_hash) WHERE email_hash IS NOT NULL;

-- ============================================================================
-- JOURNEYS (aggregated from touchpoints)
-- ============================================================================
CREATE TABLE IF NOT EXISTS journeys (
  id TEXT PRIMARY KEY,
  org_tag TEXT NOT NULL,
  user_id_hash TEXT,
  anonymous_id TEXT NOT NULL,

  -- Path data (JSON array of channel_group values)
  channel_path TEXT NOT NULL,
  path_length INTEGER NOT NULL,

  -- Timestamps
  first_touch_ts TEXT NOT NULL,
  last_touch_ts TEXT NOT NULL,

  -- Outcome
  converted INTEGER DEFAULT 0,
  conversion_id TEXT,
  conversion_value_cents INTEGER DEFAULT 0,
  conversion_goal_id TEXT,

  -- Journey metrics
  time_to_conversion_hours REAL,

  computed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_j_org ON journeys(org_tag);
CREATE INDEX IF NOT EXISTS idx_j_org_converted ON journeys(org_tag, converted);
CREATE INDEX IF NOT EXISTS idx_j_org_user ON journeys(org_tag, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_j_org_ts ON journeys(org_tag, first_touch_ts DESC);

-- ============================================================================
-- CHANNEL TRANSITIONS (Markov transition matrix)
-- ============================================================================
CREATE TABLE IF NOT EXISTS channel_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,

  from_channel TEXT NOT NULL,  -- '(start)', 'paid_search', 'organic_search', etc.
  to_channel TEXT NOT NULL,    -- 'paid_social', '(conversion)', '(null)', etc.

  -- Transition counts
  transition_count INTEGER NOT NULL DEFAULT 0,
  converting_count INTEGER NOT NULL DEFAULT 0,

  -- Probability
  probability REAL NOT NULL DEFAULT 0,

  -- Period
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, from_channel, to_channel, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ct_org ON channel_transitions(org_tag);
CREATE INDEX IF NOT EXISTS idx_ct_org_period ON channel_transitions(org_tag, period_start);

-- ============================================================================
-- ATTRIBUTION RESULTS (Markov/Shapley credits by channel)
-- ============================================================================
CREATE TABLE IF NOT EXISTS attribution_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,

  model TEXT NOT NULL,  -- 'markov', 'shapley', 'first_touch', 'last_touch', 'linear', 'time_decay', 'position_based'
  channel TEXT NOT NULL,

  -- Attribution metrics
  credit REAL NOT NULL,           -- 0-1, normalized
  conversions REAL NOT NULL,      -- Attributed conversions
  revenue_cents INTEGER NOT NULL, -- Attributed revenue

  -- Model-specific data
  removal_effect REAL,            -- Markov: conversion rate drop when channel removed
  shapley_value REAL,             -- Shapley: fair value contribution

  -- Period
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, model, channel, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ar_org_model ON attribution_results(org_tag, model);
CREATE INDEX IF NOT EXISTS idx_ar_org_period ON attribution_results(org_tag, period_start);

-- ============================================================================
-- HOURLY METRICS (replaces Supabase event_hourly_metrics_mv)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hourly_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  hour TEXT NOT NULL,  -- '2025-01-12T14:00:00Z'

  -- Event counts
  total_events INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  form_submits INTEGER DEFAULT 0,
  custom_events INTEGER DEFAULT 0,

  -- Unique counts
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  devices INTEGER DEFAULT 0,

  -- Conversions
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,

  -- Breakdown by channel (JSON)
  by_channel TEXT,

  -- Breakdown by device (JSON)
  by_device TEXT,

  created_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, hour)
);

CREATE INDEX IF NOT EXISTS idx_hm_org_hour ON hourly_metrics(org_tag, hour DESC);

-- ============================================================================
-- DAILY METRICS (replaces Supabase event_daily_metrics_mv)
-- ============================================================================
CREATE TABLE IF NOT EXISTS daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  date TEXT NOT NULL,  -- '2025-01-12'

  -- Event counts
  total_events INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  form_submits INTEGER DEFAULT 0,
  custom_events INTEGER DEFAULT 0,

  -- Unique counts
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  devices INTEGER DEFAULT 0,
  new_users INTEGER DEFAULT 0,
  returning_users INTEGER DEFAULT 0,

  -- Conversions
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  conversion_rate REAL DEFAULT 0,

  -- Breakdowns (JSON)
  by_channel TEXT,
  by_device TEXT,
  by_geo TEXT,
  by_page TEXT,

  -- UTM performance (JSON)
  by_utm_source TEXT,
  by_utm_campaign TEXT,

  created_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, date)
);

CREATE INDEX IF NOT EXISTS idx_dm_org_date ON daily_metrics(org_tag, date DESC);

-- ============================================================================
-- UTM CAMPAIGN PERFORMANCE (replaces Supabase utm_campaign_performance_mv)
-- ============================================================================
CREATE TABLE IF NOT EXISTS utm_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  date TEXT NOT NULL,

  -- UTM parameters
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,

  -- Metrics
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  conversion_rate REAL DEFAULT 0,

  -- Engagement
  avg_session_duration_seconds INTEGER,
  bounce_rate REAL,

  created_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, date, utm_source, utm_medium, utm_campaign)
);

CREATE INDEX IF NOT EXISTS idx_utm_org_date ON utm_performance(org_tag, date DESC);
CREATE INDEX IF NOT EXISTS idx_utm_org_source ON utm_performance(org_tag, utm_source);
CREATE INDEX IF NOT EXISTS idx_utm_org_campaign ON utm_performance(org_tag, utm_campaign);

-- ============================================================================
-- SYNC WATERMARKS (track sync progress)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sync_watermarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  sync_type TEXT NOT NULL,  -- 'events', 'touchpoints', 'aggregations', 'attribution'

  last_synced_ts TEXT NOT NULL,
  last_ingest_ts TEXT,
  records_synced INTEGER DEFAULT 0,

  status TEXT DEFAULT 'success',  -- 'success', 'failed', 'in_progress'
  error_message TEXT,

  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, sync_type)
);

CREATE INDEX IF NOT EXISTS idx_sw_org ON sync_watermarks(org_tag);

-- ============================================================================
-- COMMENTS
-- ============================================================================
-- This schema supports the pure Cloudflare analytics architecture:
--
-- Data Flow:
-- 1. R2 Datalake (raw events) -> EventsSyncWorkflow -> touchpoints, customer_identities
-- 2. AggregationWorkflow -> hourly_metrics, daily_metrics, utm_performance
-- 3. AttributionWorkflow -> journeys, channel_transitions, attribution_results
--
-- The dashboard queries these D1 tables instead of Supabase.
-- R2 SQL is only used for ad-hoc raw event queries.
