-- Unified Payments/Billing Tables
-- Supports: Stripe, PayPal, Braintree, Chargebee, Recurly, Paddle, Lemon Squeezy

CREATE TABLE IF NOT EXISTS payments_customers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  name TEXT,
  description TEXT,
  currency TEXT DEFAULT 'USD',
  balance_cents INTEGER DEFAULT 0,
  delinquent INTEGER DEFAULT 0,
  tax_exempt TEXT,                     -- 'none', 'exempt', 'reverse'
  default_payment_method TEXT,
  metadata TEXT,                       -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS payments_subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,                   -- References payments_customers.id
  customer_external_id TEXT,
  status TEXT NOT NULL,                -- 'active', 'past_due', 'canceled', 'trialing', 'paused'
  plan_id TEXT,
  plan_name TEXT,
  quantity INTEGER DEFAULT 1,
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  interval_unit TEXT,                  -- 'day', 'week', 'month', 'year'
  interval_count INTEGER DEFAULT 1,
  trial_start TEXT,
  trial_end TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  canceled_at TEXT,
  ended_at TEXT,
  metadata TEXT,                       -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  started_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS payments_transactions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  subscription_ref TEXT,
  subscription_external_id TEXT,
  transaction_type TEXT NOT NULL,      -- 'charge', 'refund', 'payout', 'transfer'
  status TEXT NOT NULL,                -- 'succeeded', 'pending', 'failed', 'canceled'
  amount_cents INTEGER DEFAULT 0,
  fee_cents INTEGER DEFAULT 0,
  net_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  payment_method_type TEXT,            -- 'card', 'bank', 'paypal', 'crypto'
  payment_method_last4 TEXT,
  payment_method_brand TEXT,
  description TEXT,
  failure_code TEXT,
  failure_message TEXT,
  invoice_external_id TEXT,
  metadata TEXT,                       -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  transacted_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS payments_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  subscription_ref TEXT,
  subscription_external_id TEXT,
  invoice_number TEXT,
  status TEXT NOT NULL,                -- 'draft', 'open', 'paid', 'void', 'uncollectible'
  subtotal_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  discount_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  amount_paid_cents INTEGER DEFAULT 0,
  amount_due_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  collection_method TEXT,              -- 'charge_automatically', 'send_invoice'
  billing_reason TEXT,                 -- 'subscription_create', 'subscription_cycle', 'manual'
  due_date TEXT,
  paid_at TEXT,
  period_start TEXT,
  period_end TEXT,
  metadata TEXT,                       -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  invoiced_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS payments_plans (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',        -- 'active', 'archived'
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  interval_unit TEXT,
  interval_count INTEGER DEFAULT 1,
  trial_days INTEGER DEFAULT 0,
  metadata TEXT,                       -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_payments_customers_org ON payments_customers(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_payments_subscriptions_org ON payments_subscriptions(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_payments_subscriptions_customer ON payments_subscriptions(organization_id, customer_ref);
CREATE INDEX IF NOT EXISTS idx_payments_transactions_org ON payments_transactions(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_payments_transactions_date ON payments_transactions(organization_id, transacted_at);
CREATE INDEX IF NOT EXISTS idx_payments_invoices_org ON payments_invoices(organization_id, source_platform);
