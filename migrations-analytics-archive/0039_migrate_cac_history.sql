-- Migration: Move cac_history from AI_DB to ANALYTICS_DB
-- This table stores pre-computed daily CAC metrics with goal-awareness.
-- cac_predictions and cac_baselines remain in AI_DB (genuine model outputs).

CREATE TABLE IF NOT EXISTS cac_history (
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
  UNIQUE(organization_id, date)
);

CREATE INDEX IF NOT EXISTS idx_cac_history_org_date ON cac_history(organization_id, date DESC);
