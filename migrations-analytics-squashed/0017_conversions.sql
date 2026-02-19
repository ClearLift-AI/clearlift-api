-- Grouped migration: conversions
-- Tables: conversions, conversion_attribution, conversion_daily_summary, conversion_value_allocations

-- Table: conversions
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

-- Indexes for conversions
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

-- Table: conversion_attribution
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

-- Indexes for conversion_attribution
CREATE INDEX idx_ca_campaign ON conversion_attribution(touchpoint_campaign_id);
CREATE INDEX idx_ca_conv ON conversion_attribution(conversion_id);
CREATE INDEX idx_ca_org_model ON conversion_attribution(organization_id, model);
CREATE INDEX idx_ca_platform ON conversion_attribution(organization_id, touchpoint_platform);
CREATE UNIQUE INDEX idx_ca_unique ON conversion_attribution(organization_id, conversion_id, model, touchpoint_position);

-- Table: conversion_daily_summary
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

-- Indexes for conversion_daily_summary
CREATE INDEX idx_cds_org_date ON conversion_daily_summary(organization_id, summary_date DESC);

-- Table: conversion_value_allocations
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

-- Indexes for conversion_value_allocations
CREATE INDEX idx_cva_conversion ON conversion_value_allocations(conversion_id);
CREATE INDEX idx_cva_goal ON conversion_value_allocations(goal_id);
CREATE INDEX idx_cva_org_created ON conversion_value_allocations(organization_id, created_at);
