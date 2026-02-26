-- Grouped migration: cac
-- Tables: cac_baselines, cac_predictions

-- Table: cac_baselines
CREATE TABLE cac_baselines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  baseline_date TEXT NOT NULL,
  actual_cac_cents INTEGER NOT NULL,
  baseline_cac_cents INTEGER NOT NULL,
  calculation_method TEXT NOT NULL DEFAULT 'trend_extrapolation',
  calculation_data TEXT DEFAULT '{}',
  active_recommendations TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(organization_id, baseline_date)
);

-- Indexes for cac_baselines
CREATE INDEX idx_cac_baselines_org_date ON cac_baselines(organization_id, baseline_date DESC);

-- Table: cac_predictions
CREATE TABLE cac_predictions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  predicted_cac_cents INTEGER NOT NULL,
  predicted_cac_lower_cents INTEGER,
  predicted_cac_upper_cents INTEGER,
  recommendation_ids TEXT DEFAULT '[]',
  analysis_run_id TEXT,
  assumptions TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(organization_id, prediction_date)
);

-- Indexes for cac_predictions
CREATE INDEX idx_cac_predictions_org_date ON cac_predictions(organization_id, prediction_date DESC);
