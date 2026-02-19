-- Phase 2: Consolidated connector tables
-- Replaces 14 category-specific tables with 5 generic connector tables.
-- All connectors write to these tables using source_platform + event_type discriminators.
-- Adding a new connector = 1 SourceConfig entry + 1 sync worker. Zero new tables.

-- connector_transactions: all monetary events from all connectors
CREATE TABLE IF NOT EXISTS connector_transactions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'transaction',
  external_id TEXT NOT NULL,

  -- Customer linkage
  customer_ref TEXT,
  customer_external_id TEXT,
  customer_email_hash TEXT,

  -- Money (universal)
  value_cents INTEGER DEFAULT 0,
  refund_cents INTEGER DEFAULT 0,
  fee_cents INTEGER DEFAULT 0,
  net_cents INTEGER DEFAULT 0,
  subtotal_cents INTEGER DEFAULT 0,
  discount_cents INTEGER DEFAULT 0,
  shipping_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',

  -- Status
  status TEXT NOT NULL,
  financial_status TEXT,
  fulfillment_status TEXT,
  payment_status TEXT,

  -- CRM pipeline
  stage TEXT,
  pipeline TEXT,
  probability INTEGER,

  -- Timestamps
  transacted_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  close_date TEXT,
  start_time TEXT,
  end_time TEXT,

  -- Attribution signals
  description TEXT,
  source_name TEXT,
  landing_url TEXT,
  referring_site TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,

  -- Relations
  subscription_ref TEXT,
  service_ref TEXT,
  company_ref TEXT,

  -- Counts
  item_count INTEGER,
  duration_minutes INTEGER,

  -- Metadata
  metadata TEXT,
  properties TEXT,
  raw_data TEXT,

  -- Sync
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_pipeline ON connector_transactions(organization_id, source_platform, status, transacted_at);
CREATE INDEX IF NOT EXISTS idx_ct_display ON connector_transactions(organization_id, transacted_at);
CREATE INDEX IF NOT EXISTS idx_ct_customer ON connector_transactions(organization_id, customer_external_id);
CREATE INDEX IF NOT EXISTS idx_ct_email ON connector_transactions(organization_id, customer_email_hash);

-- connector_subscriptions: recurring revenue
CREATE TABLE IF NOT EXISTS connector_subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  status TEXT NOT NULL,
  plan_name TEXT,
  plan_external_id TEXT,
  amount_cents INTEGER DEFAULT 0,
  interval_type TEXT,
  interval_count INTEGER DEFAULT 1,
  currency TEXT DEFAULT 'USD',
  trial_start TEXT,
  trial_end TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  cancelled_at TEXT,
  metadata TEXT,
  properties TEXT,
  raw_data TEXT,
  started_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_cs_org ON connector_subscriptions(organization_id, source_platform, status);

-- connector_customers: all customer/contact/company records
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

-- connector_items: products, services, refunds
CREATE TABLE IF NOT EXISTS connector_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  item_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT,
  status TEXT,
  price_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  category TEXT,
  parent_external_id TEXT,
  amount_cents INTEGER DEFAULT 0,
  reason TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, item_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ci_org ON connector_items(organization_id, source_platform, item_type);

-- connector_activities: non-monetary events (CRM activities)
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
