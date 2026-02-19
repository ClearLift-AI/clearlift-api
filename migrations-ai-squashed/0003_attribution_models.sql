-- Grouped migration: attribution_models
-- Tables: attribution_model_results

-- Table: attribution_model_results
CREATE TABLE attribution_model_results (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  model TEXT NOT NULL,
  channel TEXT NOT NULL,
  attributed_credit REAL NOT NULL,
  removal_effect REAL,
  shapley_value REAL,
  computation_date DATE NOT NULL,
  conversion_count INTEGER,
  path_count INTEGER,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, model, channel, computation_date)
);

-- Indexes for attribution_model_results
CREATE INDEX idx_attr_results_expires ON attribution_model_results(expires_at);
CREATE INDEX idx_attr_results_org_model ON attribution_model_results(organization_id, model, computation_date DESC);
