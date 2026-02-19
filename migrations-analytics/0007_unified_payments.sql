-- Grouped migration: unified_payments
-- Tables: payments_customers, payments_subscriptions, payments_transactions, payments_invoices, payments_plans

-- Table: payments_customers
CREATE TABLE payments_customers (
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
  tax_exempt TEXT,
  default_payment_method TEXT,
  metadata TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for payments_customers
CREATE INDEX idx_payments_customers_org ON payments_customers(organization_id, source_platform);

-- Table: payments_subscriptions
CREATE TABLE payments_subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  status TEXT NOT NULL,
  plan_id TEXT,
  plan_name TEXT,
  quantity INTEGER DEFAULT 1,
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  interval_unit TEXT,
  interval_count INTEGER DEFAULT 1,
  trial_start TEXT,
  trial_end TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  canceled_at TEXT,
  ended_at TEXT,
  metadata TEXT,
  properties TEXT,
  raw_data TEXT,
  started_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for payments_subscriptions
CREATE INDEX idx_payments_subscriptions_customer ON payments_subscriptions(organization_id, customer_ref);
CREATE INDEX idx_payments_subscriptions_org ON payments_subscriptions(organization_id, source_platform);

-- Table: payments_transactions
CREATE TABLE payments_transactions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  subscription_ref TEXT,
  subscription_external_id TEXT,
  transaction_type TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INTEGER DEFAULT 0,
  fee_cents INTEGER DEFAULT 0,
  net_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  payment_method_type TEXT,
  payment_method_last4 TEXT,
  payment_method_brand TEXT,
  description TEXT,
  failure_code TEXT,
  failure_message TEXT,
  invoice_external_id TEXT,
  metadata TEXT,
  properties TEXT,
  raw_data TEXT,
  transacted_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for payments_transactions
CREATE INDEX idx_payments_transactions_date ON payments_transactions(organization_id, transacted_at);
CREATE INDEX idx_payments_transactions_org ON payments_transactions(organization_id, source_platform);

-- Table: payments_invoices
CREATE TABLE payments_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  subscription_ref TEXT,
  subscription_external_id TEXT,
  invoice_number TEXT,
  status TEXT NOT NULL,
  subtotal_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  discount_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  amount_paid_cents INTEGER DEFAULT 0,
  amount_due_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  collection_method TEXT,
  billing_reason TEXT,
  due_date TEXT,
  paid_at TEXT,
  period_start TEXT,
  period_end TEXT,
  metadata TEXT,
  properties TEXT,
  raw_data TEXT,
  invoiced_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for payments_invoices
CREATE INDEX idx_payments_invoices_org ON payments_invoices(organization_id, source_platform);

-- Table: payments_plans
CREATE TABLE payments_plans (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  interval_unit TEXT,
  interval_count INTEGER DEFAULT 1,
  trial_days INTEGER DEFAULT 0,
  metadata TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);
