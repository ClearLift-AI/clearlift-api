-- AI Optimization Settings
-- Stores user preferences from the Optimization Matrix for AI-driven campaign optimization

CREATE TABLE IF NOT EXISTS ai_optimization_settings (
  org_id TEXT PRIMARY KEY,

  -- Growth strategy preference
  growth_strategy TEXT NOT NULL DEFAULT 'balanced' CHECK(growth_strategy IN ('lean', 'balanced', 'bold')),

  -- Budget optimization aggressiveness (determines recommendation frequency)
  budget_optimization TEXT NOT NULL DEFAULT 'moderate' CHECK(budget_optimization IN ('conservative', 'moderate', 'aggressive')),

  -- AI control mode
  ai_control TEXT NOT NULL DEFAULT 'copilot' CHECK(ai_control IN ('copilot', 'autopilot')),

  -- Monetary limits (in cents to avoid floating point issues)
  daily_cap_cents INTEGER,
  monthly_cap_cents INTEGER,
  pause_threshold_percent INTEGER,

  -- Track when recommendations were last generated
  last_recommendation_at TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Index for querying orgs that need recommendations
CREATE INDEX IF NOT EXISTS idx_ai_settings_last_recommendation
  ON ai_optimization_settings(last_recommendation_at, budget_optimization);

-- AI Decisions / Recommendations
-- Stores AI-generated optimization recommendations that can be reviewed and applied
CREATE TABLE IF NOT EXISTS ai_decisions (
  decision_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  -- Recommendation details
  recommended_action TEXT NOT NULL,
  parameters TEXT NOT NULL, -- JSON parameters needed to execute the action
  reason TEXT NOT NULL, -- One-sentence explanation

  -- Impact and confidence
  impact TEXT NOT NULL, -- Human-readable impact statement (e.g., "Could reduce CPA by 23%")
  confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high')),

  -- Workflow state
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')),
  expires_at TEXT NOT NULL,

  -- Audit trail
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  applied_at TEXT,

  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_ai_decisions_org_status
  ON ai_decisions(org_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_org_confidence
  ON ai_decisions(org_id, confidence, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_expires
  ON ai_decisions(status, expires_at);
