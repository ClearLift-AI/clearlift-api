-- Attribution Model Pre-computed Results
-- Stores Markov Chain and Shapley Value attribution credits by channel
-- These are computed asynchronously by the Attribution Workflow and read by the attribution endpoint

CREATE TABLE IF NOT EXISTS attribution_model_results (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  model TEXT NOT NULL,  -- 'markov_chain' or 'shapley_value'
  channel TEXT NOT NULL,
  attributed_credit REAL NOT NULL,  -- 0-1 normalized credit
  removal_effect REAL,              -- Markov chain only: how much conversion rate drops when removed
  shapley_value REAL,               -- Shapley only: raw shapley value before normalization
  computation_date DATE NOT NULL,
  conversion_count INTEGER,         -- Number of conversion paths used
  path_count INTEGER,               -- Total paths (conversion + non-conversion)
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id, model, channel, computation_date)
);

-- Index for efficient queries by org and model
CREATE INDEX IF NOT EXISTS idx_attr_results_org_model
ON attribution_model_results(organization_id, model, computation_date DESC);

-- Index for cleanup of expired results
CREATE INDEX IF NOT EXISTS idx_attr_results_expires
ON attribution_model_results(expires_at);
