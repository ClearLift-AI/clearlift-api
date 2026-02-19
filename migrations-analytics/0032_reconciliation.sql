-- Grouped migration: reconciliation
-- Tables: platform_conversion_claims, reconciliation_daily_summary

-- Table: platform_conversion_claims
CREATE TABLE platform_conversion_claims (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT,
  ad_id TEXT,
  claim_date TEXT NOT NULL,
  conversion_action TEXT,
  claimed_conversions REAL DEFAULT 0,
  claimed_value_cents INTEGER DEFAULT 0,
  claimed_currency TEXT DEFAULT 'USD',
  click_id TEXT,
  click_id_type TEXT,
  matched_conversion_id TEXT,
  match_status TEXT DEFAULT 'pending',
  match_confidence REAL,
  match_method TEXT,
  verified_conversions INTEGER DEFAULT 0,
  verified_value_cents INTEGER DEFAULT 0,
  conversion_discrepancy REAL,
  value_discrepancy_cents INTEGER,
  raw_claim_data TEXT,
  synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for platform_conversion_claims
CREATE INDEX idx_pcc_campaign ON platform_conversion_claims(organization_id, campaign_id);
CREATE INDEX idx_pcc_click ON platform_conversion_claims(click_id);
CREATE INDEX idx_pcc_org_date ON platform_conversion_claims(organization_id, claim_date DESC);
CREATE INDEX idx_pcc_platform ON platform_conversion_claims(organization_id, platform);
CREATE INDEX idx_pcc_status ON platform_conversion_claims(organization_id, match_status);

-- Table: reconciliation_daily_summary
CREATE TABLE reconciliation_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  platform TEXT NOT NULL,
  total_claims INTEGER DEFAULT 0,
  claimed_conversions REAL DEFAULT 0,
  claimed_value_cents INTEGER DEFAULT 0,
  matched_claims INTEGER DEFAULT 0,
  unmatched_claims INTEGER DEFAULT 0,
  partial_matches INTEGER DEFAULT 0,
  verified_conversions INTEGER DEFAULT 0,
  verified_value_cents INTEGER DEFAULT 0,
  conversion_discrepancy REAL DEFAULT 0,
  value_discrepancy_cents INTEGER DEFAULT 0,
  discrepancy_rate REAL,
  claimed_roas REAL,
  actual_roas REAL,
  roas_inflation_percent REAL,
  ad_spend_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, summary_date, platform)
);

-- Indexes for reconciliation_daily_summary
CREATE INDEX idx_rds_org_date ON reconciliation_daily_summary(organization_id, summary_date DESC);
CREATE INDEX idx_rds_platform ON reconciliation_daily_summary(organization_id, platform);
