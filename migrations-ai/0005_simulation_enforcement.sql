-- ClearLift AI Database Migration: Simulation Enforcement
-- Adds columns to store simulation data for ALL recommendations.
-- This makes it IMPOSSIBLE to create recommendations with hallucinated impact numbers.

-- =============================================================================
-- AI_DECISIONS: ADD SIMULATION COLUMNS
-- =============================================================================

-- Stores the full simulation result (current state, simulated state, math)
ALTER TABLE ai_decisions ADD COLUMN simulation_data TEXT;

-- Confidence level from the simulation (not the LLM's guess)
ALTER TABLE ai_decisions ADD COLUMN simulation_confidence TEXT;


-- =============================================================================
-- CAC_PREDICTIONS: STORE FORECASTED CAC VALUES
-- =============================================================================
-- These are created when AI recommendations are made, BEFORE outcomes.
-- This enables truthful "Predicted with AI" line on the CAC timeline chart.

CREATE TABLE cac_predictions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- What date this prediction is for
  prediction_date TEXT NOT NULL,  -- YYYY-MM-DD

  -- Predicted values (in cents)
  predicted_cac_cents INTEGER NOT NULL,

  -- Confidence bounds (optional)
  predicted_cac_lower_cents INTEGER,
  predicted_cac_upper_cents INTEGER,

  -- Link to the recommendations that generated this prediction
  recommendation_ids TEXT DEFAULT '[]',  -- JSON array of ai_decision IDs
  analysis_run_id TEXT,

  -- What assumptions went into this prediction
  assumptions TEXT DEFAULT '{}',  -- JSON with spend_change, conversion_change, etc.

  -- Lifecycle
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  UNIQUE(organization_id, prediction_date)
);

CREATE INDEX idx_cac_predictions_org_date ON cac_predictions(organization_id, prediction_date DESC);


-- =============================================================================
-- CAC_BASELINES: COUNTERFACTUAL "NO AI" CAC VALUES
-- =============================================================================
-- Stores what CAC would have been WITHOUT AI recommendations.
-- Calculated using causal inference after recommendations are executed.

CREATE TABLE cac_baselines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- What date this baseline is for
  baseline_date TEXT NOT NULL,  -- YYYY-MM-DD

  -- Actual vs baseline CAC (in cents)
  actual_cac_cents INTEGER NOT NULL,
  baseline_cac_cents INTEGER NOT NULL,  -- What CAC would have been without AI

  -- How was the baseline calculated
  calculation_method TEXT NOT NULL DEFAULT 'trend_extrapolation',
  -- trend_extrapolation: Simple trend continuation from pre-AI period
  -- matched_control: If we have control group orgs
  -- synthetic_control: Weighted combination of similar non-AI orgs

  -- Supporting data for the calculation
  calculation_data TEXT DEFAULT '{}',  -- JSON with trend coefficients, control weights, etc.

  -- What AI actions were in effect during this period
  active_recommendations TEXT DEFAULT '[]',  -- JSON array of ai_decision IDs

  -- Lifecycle
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  UNIQUE(organization_id, baseline_date)
);

CREATE INDEX idx_cac_baselines_org_date ON cac_baselines(organization_id, baseline_date DESC);


-- =============================================================================
-- CAC_HISTORY: DAILY ACTUAL CAC VALUES (for truthful "Actual" line)
-- =============================================================================
-- Materialized daily CAC for fast chart queries.
-- Populated by daily cron job.

CREATE TABLE cac_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- Date
  date TEXT NOT NULL,  -- YYYY-MM-DD

  -- Actual values from that day
  spend_cents INTEGER NOT NULL,
  conversions INTEGER NOT NULL,
  revenue_cents INTEGER,  -- optional
  cac_cents INTEGER NOT NULL,  -- spend / conversions * 100

  -- Breakdown by platform
  platform_breakdown TEXT DEFAULT '{}',  -- { "facebook": { spend, conversions, cac }, ... }

  -- Lifecycle
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  UNIQUE(organization_id, date)
);

CREATE INDEX idx_cac_history_org_date ON cac_history(organization_id, date DESC);
