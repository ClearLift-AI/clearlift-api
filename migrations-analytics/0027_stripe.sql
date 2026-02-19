-- Grouped migration: stripe
-- Tables: stripe_charges, stripe_subscriptions, stripe_daily_summary

-- Table: stripe_charges
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

-- Indexes for stripe_charges
CREATE INDEX idx_sc_billing_reason ON stripe_charges(organization_id, billing_reason);
CREATE INDEX idx_sc_charge_type ON stripe_charges(organization_id, charge_type);
CREATE INDEX idx_sc_customer ON stripe_charges(organization_id, customer_email_hash);
CREATE INDEX idx_sc_dedup ON stripe_charges(organization_id, dedup_key);
CREATE INDEX idx_sc_new_subscriptions ON stripe_charges(organization_id, stripe_created_at) WHERE billing_reason = 'subscription_create';
CREATE INDEX idx_sc_org ON stripe_charges(organization_id);
CREATE INDEX idx_sc_org_date ON stripe_charges(organization_id, stripe_created_at DESC);
CREATE INDEX idx_sc_refund_status ON stripe_charges(organization_id, refund_status);

-- Table: stripe_subscriptions
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

-- Indexes for stripe_subscriptions
CREATE INDEX idx_ss_customer ON stripe_subscriptions(organization_id, customer_email_hash);
CREATE INDEX idx_ss_org ON stripe_subscriptions(organization_id);
CREATE INDEX idx_ss_org_active ON stripe_subscriptions(organization_id, status) WHERE status = 'active';
CREATE INDEX idx_ss_org_status ON stripe_subscriptions(organization_id, status);

-- Table: stripe_daily_summary
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

-- Indexes for stripe_daily_summary
CREATE INDEX idx_sds_org_date ON stripe_daily_summary(organization_id, summary_date DESC);
