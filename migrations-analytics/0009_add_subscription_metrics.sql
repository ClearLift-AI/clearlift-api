-- Add subscription tracking for SaaS MRR/ARR calculations
-- Distinguishes between one-time charges and subscription revenue

-- Create stripe_subscriptions table
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT,
  customer_email_hash TEXT,
  status TEXT NOT NULL, -- 'active', 'canceled', 'past_due', 'trialing', 'incomplete', 'incomplete_expired', 'paused', 'unpaid'
  plan_amount_cents INTEGER NOT NULL,
  plan_interval TEXT NOT NULL, -- 'month', 'year', 'week', 'day'
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

-- Indexes for subscription queries
CREATE INDEX IF NOT EXISTS idx_ss_org ON stripe_subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_ss_org_status ON stripe_subscriptions(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ss_org_active ON stripe_subscriptions(organization_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ss_customer ON stripe_subscriptions(organization_id, customer_email_hash);

-- Add charge_type and subscription_id to stripe_charges
ALTER TABLE stripe_charges ADD COLUMN charge_type TEXT DEFAULT 'one_time'; -- 'one_time', 'subscription', 'invoice'
ALTER TABLE stripe_charges ADD COLUMN subscription_id TEXT;

-- Index for filtering by charge type
CREATE INDEX IF NOT EXISTS idx_sc_charge_type ON stripe_charges(organization_id, charge_type);
