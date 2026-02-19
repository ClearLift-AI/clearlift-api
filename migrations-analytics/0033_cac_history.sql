-- Grouped migration: cac_history
-- Tables: cac_history

-- Table: cac_history
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

-- Indexes for cac_history
CREATE INDEX idx_cac_history_org_date ON cac_history(organization_id, date DESC);
