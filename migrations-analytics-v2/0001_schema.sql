-- ============================================================================
-- adbliss-analytics-0: Consolidated Analytics Database Schema
-- ============================================================================
-- Merges: old ANALYTICS_DB live tables + identity tables from DB + webhook_events from DB
-- Excludes: 32 scaffolding tables (comm_*, support_*, forms_*, etc.)
-- Excludes: 24 dead per-category connector tables (replaced by connector_* tables)
-- Excludes: shard infra tables
-- ============================================================================

-- ============================================================================
-- CONNECTORS - LIVE (4 tables)
-- ============================================================================

-- Thin event log: raw platform events from all connectors.
-- Platform-specific details go in metadata JSON. Status is RAW from platform.
CREATE TABLE IF NOT EXISTS connector_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  event_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_external_id TEXT,
  customer_email_hash TEXT,
  value_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL,
  transacted_at TEXT NOT NULL,
  created_at_platform TEXT,
  metadata TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ce_pipeline ON connector_events(organization_id, source_platform, status, transacted_at);
CREATE INDEX IF NOT EXISTS idx_ce_display ON connector_events(organization_id, transacted_at);
CREATE INDEX IF NOT EXISTS idx_ce_customer ON connector_events(organization_id, customer_external_id);
CREATE INDEX IF NOT EXISTS idx_ce_email ON connector_events(organization_id, customer_email_hash);

CREATE TABLE IF NOT EXISTS connector_customers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'person',
  external_id TEXT NOT NULL,
  email_hash TEXT,
  phone_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  domain TEXT,
  job_title TEXT,
  industry TEXT,
  lifecycle_stage TEXT,
  lead_status TEXT,
  lead_score INTEGER,
  total_spent_cents INTEGER DEFAULT 0,
  total_orders INTEGER DEFAULT 0,
  total_bookings INTEGER DEFAULT 0,
  accepts_marketing INTEGER DEFAULT 0,
  tags TEXT,
  currency TEXT DEFAULT 'USD',
  first_activity_at TEXT,
  last_activity_at TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, entity_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_cc_email ON connector_customers(organization_id, email_hash);
CREATE INDEX IF NOT EXISTS idx_cc_org ON connector_customers(organization_id, source_platform, entity_type);

CREATE TABLE IF NOT EXISTS connector_activities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  contact_ref TEXT,
  contact_external_id TEXT,
  company_ref TEXT,
  deal_ref TEXT,
  subject TEXT,
  body_preview TEXT,
  status TEXT,
  occurred_at TEXT,
  duration_minutes INTEGER,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ca_org ON connector_activities(organization_id, source_platform, activity_type);

-- ============================================================================
-- AD PLATFORMS (5 tables)
-- ============================================================================

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

CREATE INDEX idx_adc_org ON ad_campaigns(organization_id);
CREATE INDEX idx_adc_org_platform ON ad_campaigns(organization_id, platform);
CREATE INDEX idx_adc_org_platform_account ON ad_campaigns(organization_id, platform, account_id);
CREATE INDEX idx_adc_status ON ad_campaigns(organization_id, campaign_status);

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

CREATE INDEX idx_adg_campaign_ref ON ad_groups(campaign_ref);
CREATE INDEX idx_adg_org ON ad_groups(organization_id);
CREATE INDEX idx_adg_org_platform ON ad_groups(organization_id, platform);
CREATE INDEX idx_adg_status ON ad_groups(organization_id, ad_group_status);

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

CREATE INDEX idx_ads_ad_group_ref ON ads(ad_group_ref);
CREATE INDEX idx_ads_campaign_ref ON ads(campaign_ref);
CREATE INDEX idx_ads_org ON ads(organization_id);
CREATE INDEX idx_ads_org_platform ON ads(organization_id, platform);
CREATE INDEX idx_ads_status ON ads(organization_id, ad_status);

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

CREATE INDEX idx_adm_entity ON ad_metrics(entity_ref, metric_date DESC);
CREATE INDEX idx_adm_org_date ON ad_metrics(organization_id, metric_date DESC);
CREATE INDEX idx_adm_org_platform_date ON ad_metrics(organization_id, platform, metric_date DESC);
CREATE INDEX idx_adm_org_type_date ON ad_metrics(organization_id, entity_type, metric_date DESC);

CREATE TABLE facebook_pages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  category TEXT,
  category_list TEXT,
  fan_count INTEGER DEFAULT 0,
  followers_count INTEGER DEFAULT 0,
  link TEXT,
  picture_url TEXT,
  cover_url TEXT,
  about TEXT,
  description TEXT,
  website TEXT,
  phone TEXT,
  emails TEXT,
  location TEXT,
  hours TEXT,
  is_published INTEGER DEFAULT 1,
  verification_status TEXT,
  access_token TEXT,
  token_expires_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, page_id)
);

CREATE INDEX idx_facebook_pages_account ON facebook_pages(account_id);
CREATE INDEX idx_facebook_pages_org ON facebook_pages(organization_id);
CREATE INDEX idx_facebook_pages_page_id ON facebook_pages(page_id);

-- ============================================================================
-- EVENTS & IDENTITY (5 tables)
-- ============================================================================

CREATE TABLE IF NOT EXISTS touchpoints (
  id TEXT PRIMARY KEY,
  org_tag TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  user_id_hash TEXT,
  session_id TEXT,
  device_fingerprint_id TEXT,
  touchpoint_ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  page_path TEXT,
  page_title TEXT,
  referrer_domain TEXT,
  channel_group TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  gclid TEXT,
  fbclid TEXT,
  ttclid TEXT,
  msclkid TEXT,
  email_link_id TEXT,
  device_type TEXT,
  browser_name TEXT,
  geo_country TEXT,
  geo_region TEXT,
  geo_city TEXT,
  conversion_id TEXT,
  goal_value_cents INTEGER,
  position_in_journey INTEGER,
  total_touchpoints_in_journey INTEGER,
  time_to_conversion_hours REAL,
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

CREATE INDEX IF NOT EXISTS idx_tp_org_ts ON touchpoints(org_tag, touchpoint_ts DESC);
CREATE INDEX IF NOT EXISTS idx_tp_org_anon ON touchpoints(org_tag, anonymous_id);
CREATE INDEX IF NOT EXISTS idx_tp_org_user ON touchpoints(org_tag, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tp_org_session ON touchpoints(org_tag, session_id);
CREATE INDEX IF NOT EXISTS idx_tp_org_channel ON touchpoints(org_tag, channel_group);
CREATE INDEX IF NOT EXISTS idx_tp_conversion ON touchpoints(org_tag, conversion_id) WHERE conversion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tp_gclid ON touchpoints(gclid) WHERE gclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tp_fbclid ON touchpoints(fbclid) WHERE fbclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tp_ttclid ON touchpoints(ttclid) WHERE ttclid IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  org_tag TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  user_id_hash TEXT,
  email_hash TEXT,
  device_fingerprint_id TEXT,
  stripe_customer_id TEXT,
  shopify_customer_id TEXT,
  identity_method TEXT NOT NULL,
  identity_confidence REAL DEFAULT 0.3,
  first_touch_source TEXT,
  first_touch_medium TEXT,
  first_touch_campaign TEXT,
  first_touch_click_id TEXT,
  first_touch_click_id_type TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  total_sessions INTEGER DEFAULT 0,
  total_touchpoints INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  known_devices TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  -- Added by migration 0034
  phone_hash TEXT,
  canonical_user_id TEXT,
  hubspot_contact_id TEXT,
  salesforce_contact_id TEXT,
  jobber_client_id TEXT,
  merged_into_id TEXT,
  merged_at TEXT,
  is_canonical INTEGER DEFAULT 1,
  UNIQUE(org_tag, anonymous_id)
);

CREATE INDEX IF NOT EXISTS idx_ci_org ON customer_identities(org_tag);
CREATE INDEX IF NOT EXISTS idx_ci_org_user ON customer_identities(org_tag, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_org_email ON customer_identities(org_tag, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_phone_hash ON customer_identities(org_tag, phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_canonical ON customer_identities(canonical_user_id) WHERE canonical_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_hubspot ON customer_identities(hubspot_contact_id) WHERE hubspot_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_salesforce ON customer_identities(salesforce_contact_id) WHERE salesforce_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_jobber ON customer_identities(jobber_client_id) WHERE jobber_client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_merged_into ON customer_identities(merged_into_id) WHERE merged_into_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS identity_link_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_identity_id TEXT NOT NULL,
  target_identity_id TEXT,
  link_type TEXT NOT NULL,
  link_confidence REAL DEFAULT 1.0,
  link_source TEXT,
  link_metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_identity_id, target_identity_id, link_type, created_at)
);

CREATE INDEX IF NOT EXISTS idx_ile_org ON identity_link_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_ile_source ON identity_link_events(source_identity_id);
CREATE INDEX IF NOT EXISTS idx_ile_target ON identity_link_events(target_identity_id) WHERE target_identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ile_type ON identity_link_events(link_type);
CREATE INDEX IF NOT EXISTS idx_ile_created ON identity_link_events(organization_id, created_at);

-- Moved from core DB: customer/visitor identity tables, not auth users
CREATE TABLE identity_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_user_id TEXT,
  identified_at TEXT NOT NULL,
  first_seen_at TEXT,
  source TEXT DEFAULT 'identify',
  confidence REAL DEFAULT 1.0,
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, anonymous_id, user_id)
);

CREATE INDEX idx_identity_canonical ON identity_mappings(organization_id, canonical_user_id);
CREATE INDEX idx_identity_identified_at ON identity_mappings(organization_id, identified_at);
CREATE INDEX idx_identity_org_anon ON identity_mappings(organization_id, anonymous_id);
CREATE INDEX idx_identity_org_user ON identity_mappings(organization_id, user_id);

CREATE TABLE identity_merges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  merged_at TEXT DEFAULT CURRENT_TIMESTAMP,
  merged_by TEXT,
  reason TEXT
);

CREATE INDEX idx_merge_org ON identity_merges(organization_id);
CREATE INDEX idx_merge_source ON identity_merges(organization_id, source_user_id);
CREATE INDEX idx_merge_target ON identity_merges(organization_id, target_user_id);

-- ============================================================================
-- WEBHOOK LOG (1 table - moved from core DB)
-- ============================================================================

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT,
  payload_hash TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  error_message TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT,
  unified_event_type TEXT
);

CREATE INDEX idx_webhook_events_connector_unified ON webhook_events(organization_id, connector, unified_event_type);
CREATE INDEX idx_webhook_events_dedup ON webhook_events(organization_id, connector, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_webhook_events_endpoint ON webhook_events(endpoint_id);
CREATE INDEX idx_webhook_events_hash ON webhook_events(organization_id, connector, payload_hash) WHERE payload_hash IS NOT NULL;
CREATE INDEX idx_webhook_events_status ON webhook_events(status, received_at);
CREATE INDEX idx_webhook_events_unified_type ON webhook_events(organization_id, unified_event_type);

-- ============================================================================
-- JOURNEYS & ATTRIBUTION (7 tables)
-- ============================================================================

CREATE TABLE IF NOT EXISTS journeys (
  id TEXT PRIMARY KEY,
  org_tag TEXT NOT NULL,
  user_id_hash TEXT,
  anonymous_id TEXT NOT NULL,
  channel_path TEXT NOT NULL,
  path_length INTEGER NOT NULL,
  first_touch_ts TEXT NOT NULL,
  last_touch_ts TEXT NOT NULL,
  converted INTEGER DEFAULT 0,
  conversion_id TEXT,
  conversion_value_cents INTEGER DEFAULT 0,
  conversion_goal_id TEXT,
  time_to_conversion_hours REAL,
  computed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_j_org ON journeys(org_tag);
CREATE INDEX IF NOT EXISTS idx_j_org_converted ON journeys(org_tag, converted);
CREATE INDEX IF NOT EXISTS idx_j_org_user ON journeys(org_tag, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_j_org_ts ON journeys(org_tag, first_touch_ts DESC);

CREATE TABLE IF NOT EXISTS journey_touchpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id TEXT NOT NULL,
  touchpoint_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  FOREIGN KEY (journey_id) REFERENCES journeys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jt_journey ON journey_touchpoints(journey_id);

CREATE TABLE IF NOT EXISTS journey_analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  channel_distribution TEXT NOT NULL,
  entry_channels TEXT NOT NULL,
  exit_channels TEXT NOT NULL,
  transition_matrix TEXT NOT NULL,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  converting_sessions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  avg_path_length REAL DEFAULT 0,
  common_paths TEXT NOT NULL,
  data_quality_level INTEGER DEFAULT 1,
  data_quality_report TEXT,
  total_conversions INTEGER DEFAULT 0,
  matched_conversions INTEGER DEFAULT 0,
  match_breakdown TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_journey_analytics_org ON journey_analytics(org_tag);
CREATE INDEX IF NOT EXISTS idx_journey_analytics_period ON journey_analytics(org_tag, period_start DESC, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_journey_analytics_quality ON journey_analytics(org_tag, data_quality_level);

CREATE TABLE attribution_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  model TEXT NOT NULL,
  channel TEXT NOT NULL,
  credit REAL NOT NULL,
  conversions REAL NOT NULL,
  revenue_cents INTEGER NOT NULL,
  removal_effect REAL,
  shapley_value REAL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, model, channel, period_start)
);

CREATE INDEX idx_ar_org_model ON attribution_results(org_tag, model);
CREATE INDEX idx_ar_org_period ON attribution_results(org_tag, period_start);

-- Pre-computed attribution results from AI_DB
CREATE TABLE IF NOT EXISTS attribution_model_results (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  model TEXT NOT NULL,
  channel TEXT NOT NULL,
  attributed_credit REAL NOT NULL,
  removal_effect REAL,
  shapley_value REAL,
  computation_date DATE NOT NULL,
  conversion_count INTEGER,
  path_count INTEGER,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, model, channel, computation_date)
);

CREATE INDEX IF NOT EXISTS idx_attr_results_org_model ON attribution_model_results(organization_id, model, computation_date DESC);
CREATE INDEX IF NOT EXISTS idx_attr_results_expires ON attribution_model_results(expires_at);

CREATE TABLE channel_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  from_channel TEXT NOT NULL,
  to_channel TEXT NOT NULL,
  transition_count INTEGER NOT NULL DEFAULT 0,
  converting_count INTEGER NOT NULL DEFAULT 0,
  probability REAL NOT NULL DEFAULT 0,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, from_channel, to_channel, period_start)
);

CREATE INDEX idx_ct_org ON channel_transitions(org_tag);
CREATE INDEX idx_ct_org_from_channel ON channel_transitions(org_tag, from_channel);
CREATE INDEX idx_ct_org_period ON channel_transitions(org_tag, period_start);
CREATE INDEX idx_ct_org_period_from ON channel_transitions(org_tag, period_start, from_channel);
CREATE INDEX idx_ct_org_to_channel ON channel_transitions(org_tag, to_channel);

CREATE TABLE funnel_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_name TEXT,
  visitors_at_from INTEGER NOT NULL DEFAULT 0,
  visitors_transitioned INTEGER NOT NULL DEFAULT 0,
  transition_rate REAL NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  avg_time_to_transition_hours REAL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, from_type, from_id, to_type, to_id, period_start)
);

CREATE INDEX idx_ft_org ON funnel_transitions(org_tag);
CREATE INDEX idx_ft_org_from ON funnel_transitions(org_tag, from_type, from_id);
CREATE INDEX idx_ft_org_period ON funnel_transitions(org_tag, period_start);
CREATE INDEX idx_ft_org_to ON funnel_transitions(org_tag, to_type, to_id);

-- ============================================================================
-- CONVERSIONS (4 tables)
-- ============================================================================

CREATE TABLE conversions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  conversion_source TEXT NOT NULL,
  source_id TEXT,
  source_platform TEXT,
  attributed_platform TEXT,
  attributed_campaign_id TEXT,
  attributed_ad_group_id TEXT,
  attributed_ad_id TEXT,
  attribution_model TEXT,
  click_id TEXT,
  click_id_type TEXT,
  value_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  customer_id TEXT,
  customer_email_hash TEXT,
  anonymous_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  conversion_timestamp TEXT NOT NULL,
  click_timestamp TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  dedup_key TEXT,
  linked_goal_id TEXT,
  link_confidence REAL DEFAULT 1.0,
  link_method TEXT,
  linked_at TEXT,
  goal_ids TEXT,
  goal_values TEXT,
  attribution_group_id TEXT,
  unified_event_type TEXT,
  connector TEXT,
  event_type TEXT,
  refund_cents INTEGER DEFAULT 0,
  refund_status TEXT DEFAULT 'none',
  refunded_at TEXT,
  handoff_observation_id TEXT
);

CREATE INDEX idx_conv_anon ON conversions(organization_id, anonymous_id);
CREATE INDEX idx_conv_click_id ON conversions(click_id);
CREATE INDEX idx_conv_connector ON conversions(organization_id, connector);
CREATE INDEX idx_conv_dedup ON conversions(organization_id, dedup_key);
CREATE UNIQUE INDEX idx_conv_dedup_unique ON conversions(organization_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX idx_conv_email ON conversions(organization_id, customer_email_hash);
CREATE INDEX idx_conv_org_campaign_date ON conversions(organization_id, attributed_campaign_id, conversion_timestamp DESC);
CREATE INDEX idx_conv_org_date ON conversions(organization_id, conversion_timestamp DESC);
CREATE INDEX idx_conv_org_platform_date ON conversions(organization_id, attributed_platform, conversion_timestamp DESC);
CREATE INDEX idx_conv_org_source_date ON conversions(organization_id, conversion_source, conversion_timestamp DESC);
CREATE INDEX idx_conv_org_source_platform_date ON conversions(organization_id, conversion_source, attributed_platform, conversion_timestamp DESC);
CREATE INDEX idx_conv_platform ON conversions(organization_id, attributed_platform);
CREATE INDEX idx_conv_refund_status ON conversions(organization_id, refund_status) WHERE refund_status != 'none';
CREATE INDEX idx_conv_source ON conversions(organization_id, conversion_source);
CREATE UNIQUE INDEX idx_conv_source_unique ON conversions(organization_id, conversion_source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX idx_conv_unified_type ON conversions(organization_id, unified_event_type);
CREATE INDEX idx_conversions_attribution_group ON conversions(organization_id, attribution_group_id) WHERE attribution_group_id IS NOT NULL;
CREATE INDEX idx_conversions_goal_ids ON conversions(organization_id) WHERE goal_ids IS NOT NULL;
CREATE INDEX idx_conversions_link_method ON conversions(organization_id, link_method) WHERE link_method IS NOT NULL;
CREATE INDEX idx_conversions_linked_goal ON conversions(organization_id, linked_goal_id) WHERE linked_goal_id IS NOT NULL;
CREATE INDEX idx_conversions_unlinked ON conversions(organization_id, conversion_source, conversion_timestamp) WHERE linked_goal_id IS NULL;

CREATE TABLE conversion_attribution (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  conversion_id TEXT NOT NULL,
  model TEXT NOT NULL,
  touchpoint_type TEXT NOT NULL,
  touchpoint_platform TEXT,
  touchpoint_campaign_id TEXT,
  touchpoint_ad_group_id TEXT,
  touchpoint_ad_id TEXT,
  touchpoint_timestamp TEXT,
  click_id TEXT,
  click_id_type TEXT,
  credit_percent REAL NOT NULL,
  credit_value_cents INTEGER NOT NULL,
  touchpoint_position INTEGER,
  total_touchpoints INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_ca_campaign ON conversion_attribution(touchpoint_campaign_id);
CREATE INDEX idx_ca_conv ON conversion_attribution(conversion_id);
CREATE INDEX idx_ca_org_model ON conversion_attribution(organization_id, model);
CREATE INDEX idx_ca_platform ON conversion_attribution(organization_id, touchpoint_platform);
CREATE UNIQUE INDEX idx_ca_unique ON conversion_attribution(organization_id, conversion_id, model, touchpoint_position);

CREATE TABLE conversion_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  conversion_source TEXT NOT NULL,
  attributed_platform TEXT,
  conversion_count INTEGER DEFAULT 0,
  total_value_cents INTEGER DEFAULT 0,
  unique_customers INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, conversion_source, attributed_platform)
);

CREATE INDEX idx_cds_org_date ON conversion_daily_summary(organization_id, summary_date DESC);

CREATE TABLE conversion_value_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  conversion_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  allocated_value_cents INTEGER NOT NULL,
  allocation_method TEXT NOT NULL,
  weight_used REAL,
  touchpoint_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversion_id) REFERENCES conversions(id) ON DELETE CASCADE
);

CREATE INDEX idx_cva_conversion ON conversion_value_allocations(conversion_id);
CREATE INDEX idx_cva_goal ON conversion_value_allocations(goal_id);
CREATE INDEX idx_cva_org_created ON conversion_value_allocations(organization_id, created_at);

-- ============================================================================
-- METRICS & AGGREGATIONS (7 tables)
-- ============================================================================

CREATE TABLE IF NOT EXISTS hourly_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  hour TEXT NOT NULL,
  total_events INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  form_submits INTEGER DEFAULT 0,
  custom_events INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  devices INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  by_channel TEXT,
  by_device TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, hour)
);

CREATE INDEX IF NOT EXISTS idx_hm_org_hour ON hourly_metrics(org_tag, hour DESC);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  date TEXT NOT NULL,
  total_events INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  form_submits INTEGER DEFAULT 0,
  custom_events INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  devices INTEGER DEFAULT 0,
  new_users INTEGER DEFAULT 0,
  returning_users INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  by_channel TEXT,
  by_device TEXT,
  by_geo TEXT,
  by_page TEXT,
  by_utm_source TEXT,
  by_utm_campaign TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, date)
);

CREATE INDEX IF NOT EXISTS idx_dm_org_date ON daily_metrics(org_tag, date DESC);

CREATE TABLE IF NOT EXISTS utm_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  date TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  sessions INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_cents INTEGER DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  avg_session_duration_seconds INTEGER,
  bounce_rate REAL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, date, utm_source, utm_medium, utm_campaign)
);

CREATE INDEX IF NOT EXISTS idx_utm_org_date ON utm_performance(org_tag, date DESC);
CREATE INDEX IF NOT EXISTS idx_utm_org_source ON utm_performance(org_tag, utm_source);
CREATE INDEX IF NOT EXISTS idx_utm_org_campaign ON utm_performance(org_tag, utm_campaign);

CREATE TABLE cac_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  date TEXT NOT NULL,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  cac_cents INTEGER NOT NULL DEFAULT 0,
  conversions_goal INTEGER DEFAULT 0,
  conversions_platform INTEGER DEFAULT 0,
  conversion_source TEXT DEFAULT 'platform',
  goal_ids TEXT DEFAULT NULL,
  revenue_goal_cents INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now')),
  conversions_stripe INTEGER DEFAULT 0,
  conversions_shopify INTEGER DEFAULT 0,
  conversions_jobber INTEGER DEFAULT 0,
  conversions_tag INTEGER DEFAULT 0,
  revenue_stripe_cents INTEGER DEFAULT 0,
  revenue_shopify_cents INTEGER DEFAULT 0,
  revenue_jobber_cents INTEGER DEFAULT 0,
  UNIQUE(organization_id, date)
);

CREATE INDEX idx_cac_history_org_date ON cac_history(organization_id, date DESC);

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

CREATE INDEX idx_org_daily_summary_org ON org_daily_summary(organization_id);
CREATE INDEX idx_org_daily_summary_org_date ON org_daily_summary(organization_id, metric_date);
CREATE INDEX idx_org_daily_summary_platform ON org_daily_summary(organization_id, platform, metric_date);

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

CREATE INDEX idx_org_timeseries_org_date ON org_timeseries(organization_id, metric_date);

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

CREATE INDEX idx_campaign_period_org ON campaign_period_summary(organization_id);
CREATE INDEX idx_campaign_period_platform ON campaign_period_summary(organization_id, platform);
CREATE INDEX idx_campaign_period_type ON campaign_period_summary(organization_id, platform, period_type);

-- ============================================================================
-- OTHER ANALYTICS (3 tables)
-- ============================================================================

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

CREATE INDEX idx_platform_comparison_date ON platform_comparison(organization_id, comparison_date);
CREATE INDEX idx_platform_comparison_org ON platform_comparison(organization_id);
CREATE INDEX idx_platform_comparison_period ON platform_comparison(organization_id, period_days, comparison_date);

CREATE TABLE handoff_observations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  click_event_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  session_id TEXT,
  device_fingerprint_id TEXT,
  click_destination_hostname TEXT NOT NULL,
  click_destination_path TEXT,
  navigation_source_path TEXT,
  click_timestamp TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  geo_country TEXT,
  matched_conversion_id TEXT,
  conversion_timestamp TEXT,
  time_to_conversion_seconds REAL,
  match_confidence REAL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(click_event_id)
);

CREATE INDEX idx_ho_anon_id ON handoff_observations(anonymous_id, click_timestamp DESC);
CREATE INDEX idx_ho_org_hostname ON handoff_observations(organization_id, click_destination_hostname, click_timestamp DESC);

CREATE TABLE handoff_patterns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  click_destination_hostname TEXT NOT NULL,
  conversion_source TEXT NOT NULL,
  observation_count INTEGER DEFAULT 0,
  match_count INTEGER DEFAULT 0,
  match_rate REAL DEFAULT 0.0,
  avg_handoff_to_conversion_seconds REAL,
  p50_seconds REAL,
  p95_seconds REAL,
  min_seconds REAL,
  max_seconds REAL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_known_provider INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, click_destination_hostname, conversion_source)
);

CREATE INDEX idx_hp_org_source ON handoff_patterns(organization_id, conversion_source);

-- ============================================================================
-- INFRASTRUCTURE (5 tables)
-- ============================================================================

CREATE TABLE aggregation_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  rows_processed INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, job_type)
);

CREATE INDEX idx_aggregation_jobs_last_run ON aggregation_jobs(last_run_at);
CREATE INDEX idx_aggregation_jobs_org ON aggregation_jobs(organization_id);

CREATE TABLE connector_sync_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  account_id TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT,
  records_synced INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connector_type, account_id)
);

CREATE INDEX idx_css_org ON connector_sync_status(organization_id);
CREATE INDEX idx_css_type ON connector_sync_status(connector_type);

CREATE TABLE sync_watermarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  sync_type TEXT NOT NULL,
  last_synced_ts TEXT NOT NULL,
  last_ingest_ts TEXT,
  records_synced INTEGER DEFAULT 0,
  status TEXT DEFAULT 'success',
  error_message TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, sync_type)
);

CREATE INDEX idx_sw_org ON sync_watermarks(org_tag);

CREATE TABLE domain_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  org_tag TEXT NOT NULL,
  domain_pattern TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  claimed_at TEXT DEFAULT (datetime('now')),
  released_at TEXT,
  verified INTEGER DEFAULT 0,
  verification_token TEXT,
  UNIQUE(domain_pattern, org_tag)
);

CREATE INDEX idx_dc_active ON domain_claims(is_active, org_tag);
CREATE INDEX idx_dc_domain ON domain_claims(domain_pattern);
CREATE INDEX idx_dc_org ON domain_claims(organization_id);
CREATE INDEX idx_dc_tag ON domain_claims(org_tag);

CREATE TABLE tracked_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  click_id TEXT,
  click_id_type TEXT,
  touchpoint_type TEXT NOT NULL,
  platform TEXT,
  campaign_id TEXT,
  ad_group_id TEXT,
  ad_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  landing_url TEXT,
  landing_path TEXT,
  referrer_url TEXT,
  referrer_domain TEXT,
  anonymous_id TEXT,
  session_id TEXT,
  user_id TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  region TEXT,
  click_timestamp TEXT NOT NULL,
  converted INTEGER DEFAULT 0,
  conversion_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_tc_anon ON tracked_clicks(anonymous_id);
CREATE INDEX idx_tc_campaign ON tracked_clicks(organization_id, campaign_id);
CREATE INDEX idx_tc_click_id ON tracked_clicks(click_id);
CREATE INDEX idx_tc_converted ON tracked_clicks(organization_id, converted, click_timestamp DESC);
CREATE INDEX idx_tc_org_date ON tracked_clicks(organization_id, click_timestamp DESC);
CREATE INDEX idx_tc_session ON tracked_clicks(session_id);
CREATE UNIQUE INDEX idx_tracked_clicks_unique ON tracked_clicks(organization_id, click_id, click_timestamp) WHERE click_id IS NOT NULL;

-- ============================================================================
-- LEGACY - API still reads, will be dropped when read paths migrate (8 tables)
-- ============================================================================

CREATE TABLE stripe_charges (
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
  refund_cents INTEGER DEFAULT 0,
  refund_at TEXT,
  refund_status TEXT,
  charge_type TEXT DEFAULT 'one_time',
  subscription_id TEXT,
  dedup_key TEXT,
  billing_reason TEXT,
  UNIQUE(organization_id, connection_id, charge_id)
);

CREATE INDEX idx_sc_billing_reason ON stripe_charges(organization_id, billing_reason);
CREATE INDEX idx_sc_charge_type ON stripe_charges(organization_id, charge_type);
CREATE INDEX idx_sc_customer ON stripe_charges(organization_id, customer_email_hash);
CREATE INDEX idx_sc_dedup ON stripe_charges(organization_id, dedup_key);
CREATE INDEX idx_sc_new_subscriptions ON stripe_charges(organization_id, stripe_created_at) WHERE billing_reason = 'subscription_create';
CREATE INDEX idx_sc_org ON stripe_charges(organization_id);
CREATE INDEX idx_sc_org_date ON stripe_charges(organization_id, stripe_created_at DESC);
CREATE INDEX idx_sc_refund_status ON stripe_charges(organization_id, refund_status);

CREATE TABLE stripe_subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT,
  customer_email_hash TEXT,
  status TEXT NOT NULL,
  plan_amount_cents INTEGER NOT NULL,
  plan_interval TEXT NOT NULL,
  plan_interval_count INTEGER DEFAULT 1,
  plan_name TEXT,
  currency TEXT NOT NULL DEFAULT 'usd',
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  canceled_at TEXT,
  ended_at TEXT,
  trial_start TEXT,
  trial_end TEXT,
  stripe_created_at TEXT NOT NULL,
  metadata TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, subscription_id)
);

CREATE INDEX idx_ss_customer ON stripe_subscriptions(organization_id, customer_email_hash);
CREATE INDEX idx_ss_org ON stripe_subscriptions(organization_id);
CREATE INDEX idx_ss_org_active ON stripe_subscriptions(organization_id, status) WHERE status = 'active';
CREATE INDEX idx_ss_org_status ON stripe_subscriptions(organization_id, status);

CREATE TABLE stripe_daily_summary (
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

CREATE INDEX idx_sds_org_date ON stripe_daily_summary(organization_id, summary_date DESC);

CREATE TABLE shopify_orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  order_number TEXT,
  checkout_id TEXT,
  checkout_token TEXT,
  cart_token TEXT,
  customer_id TEXT,
  customer_email_hash TEXT,
  customer_first_name TEXT,
  customer_orders_count INTEGER,
  total_price_cents INTEGER NOT NULL,
  subtotal_price_cents INTEGER,
  total_tax_cents INTEGER DEFAULT 0,
  total_discounts_cents INTEGER DEFAULT 0,
  total_shipping_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  financial_status TEXT,
  fulfillment_status TEXT,
  landing_site TEXT,
  landing_site_path TEXT,
  referring_site TEXT,
  source_name TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  gclid TEXT,
  fbclid TEXT,
  ttclid TEXT,
  line_items_count INTEGER DEFAULT 0,
  total_items_quantity INTEGER DEFAULT 0,
  shipping_country TEXT,
  shipping_province TEXT,
  shipping_city TEXT,
  shopify_created_at TEXT NOT NULL,
  shopify_processed_at TEXT,
  shopify_cancelled_at TEXT,
  tags TEXT,
  note TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  refund_cents INTEGER DEFAULT 0,
  refund_at TEXT,
  refund_status TEXT,
  dedup_key TEXT,
  UNIQUE(organization_id, connection_id, shopify_order_id)
);

CREATE INDEX idx_so_conn ON shopify_orders(connection_id, shopify_created_at DESC);
CREATE INDEX idx_so_customer ON shopify_orders(organization_id, customer_email_hash);
CREATE INDEX idx_so_dedup ON shopify_orders(organization_id, dedup_key);
CREATE INDEX idx_so_fbclid ON shopify_orders(fbclid);
CREATE INDEX idx_so_gclid ON shopify_orders(gclid);
CREATE INDEX idx_so_org ON shopify_orders(organization_id, shopify_created_at DESC);
CREATE INDEX idx_so_refund_status ON shopify_orders(organization_id, refund_status);
CREATE INDEX idx_so_status ON shopify_orders(organization_id, financial_status);

CREATE TABLE shopify_refunds (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  shopify_refund_id TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  refund_amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  reason TEXT,
  note TEXT,
  shopify_created_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, shopify_refund_id)
);

CREATE INDEX idx_sr_order ON shopify_refunds(order_id);
CREATE INDEX idx_sr_org ON shopify_refunds(organization_id, shopify_created_at DESC);

CREATE TABLE jobber_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  jobber_job_id TEXT NOT NULL,
  job_number TEXT,
  client_id TEXT,
  client_name TEXT,
  client_email_hash TEXT,
  client_phone_hash TEXT,
  client_company_name TEXT,
  title TEXT,
  description TEXT,
  job_type TEXT,
  instructions TEXT,
  property_id TEXT,
  property_address TEXT,
  property_city TEXT,
  property_state TEXT,
  property_country TEXT,
  total_amount_cents INTEGER DEFAULT 0,
  line_items_total_cents INTEGER DEFAULT 0,
  expenses_total_cents INTEGER DEFAULT 0,
  discounts_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  job_status TEXT,
  is_completed INTEGER DEFAULT 0,
  is_invoiced INTEGER DEFAULT 0,
  assigned_to TEXT,
  team_members_count INTEGER DEFAULT 0,
  lead_source TEXT,
  scheduled_start_at TEXT,
  scheduled_end_at TEXT,
  actual_start_at TEXT,
  actual_end_at TEXT,
  completed_at TEXT,
  jobber_created_at TEXT NOT NULL,
  estimated_duration_minutes INTEGER,
  actual_duration_minutes INTEGER,
  is_recurring INTEGER DEFAULT 0,
  recurrence_rule TEXT,
  parent_job_id TEXT,
  tags TEXT,
  custom_fields TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_job_id)
);

CREATE INDEX idx_jj_client ON jobber_jobs(organization_id, client_email_hash);
CREATE INDEX idx_jj_completed ON jobber_jobs(organization_id, completed_at DESC);
CREATE INDEX idx_jj_conn ON jobber_jobs(connection_id, jobber_created_at DESC);
CREATE INDEX idx_jj_org ON jobber_jobs(organization_id, jobber_created_at DESC);
CREATE INDEX idx_jj_source ON jobber_jobs(organization_id, lead_source);
CREATE INDEX idx_jj_status ON jobber_jobs(organization_id, job_status);

CREATE TABLE jobber_clients (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  jobber_client_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  email TEXT,
  email_hash TEXT,
  phone TEXT,
  phone_hash TEXT,
  street_address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  total_jobs INTEGER DEFAULT 0,
  completed_jobs INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  total_paid_cents INTEGER DEFAULT 0,
  outstanding_balance_cents INTEGER DEFAULT 0,
  first_job_at TEXT,
  last_job_at TEXT,
  jobber_created_at TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_client_id)
);

CREATE INDEX idx_jc_email ON jobber_clients(organization_id, email_hash);
CREATE INDEX idx_jc_org ON jobber_clients(organization_id);
CREATE INDEX idx_jc_revenue ON jobber_clients(organization_id, total_revenue_cents DESC);

CREATE TABLE jobber_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  job_id TEXT,
  jobber_invoice_id TEXT NOT NULL,
  invoice_number TEXT,
  jobber_job_id TEXT,
  client_id TEXT,
  client_name TEXT,
  client_email TEXT,
  client_email_hash TEXT,
  subject TEXT,
  message TEXT,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER NOT NULL,
  amount_paid_cents INTEGER DEFAULT 0,
  balance_due_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  status TEXT,
  is_paid INTEGER DEFAULT 0,
  issue_date TEXT,
  due_date TEXT,
  paid_at TEXT,
  jobber_created_at TEXT NOT NULL,
  payment_method TEXT,
  deposit_account TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_invoice_id)
);

CREATE INDEX idx_ji_client ON jobber_invoices(organization_id, client_email_hash);
CREATE INDEX idx_ji_conn ON jobber_invoices(connection_id, jobber_created_at DESC);
CREATE INDEX idx_ji_job ON jobber_invoices(job_id);
CREATE INDEX idx_ji_org ON jobber_invoices(organization_id, jobber_created_at DESC);
CREATE INDEX idx_ji_paid ON jobber_invoices(organization_id, paid_at DESC);
CREATE INDEX idx_ji_status ON jobber_invoices(organization_id, status);
