-- AI Recommendations System
-- Adds the correct tables for AI-powered recommendations

-- AI Optimization Settings
CREATE TABLE IF NOT EXISTS ai_optimization_settings (
  org_id TEXT PRIMARY KEY,
  growth_strategy TEXT NOT NULL DEFAULT 'balanced' CHECK(growth_strategy IN ('lean', 'balanced', 'bold')),
  budget_optimization TEXT NOT NULL DEFAULT 'moderate' CHECK(budget_optimization IN ('conservative', 'moderate', 'aggressive')),
  ai_control TEXT NOT NULL DEFAULT 'copilot' CHECK(ai_control IN ('copilot', 'autopilot')),
  daily_cap_cents INTEGER,
  monthly_cap_cents INTEGER,
  pause_threshold_percent INTEGER,
  last_recommendation_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_settings_last_recommendation
  ON ai_optimization_settings(last_recommendation_at, budget_optimization);

-- AI Decisions / Recommendations
CREATE TABLE IF NOT EXISTS ai_decisions (
  decision_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  parameters TEXT NOT NULL,
  reason TEXT NOT NULL,
  impact TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  applied_at TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_org_status
  ON ai_decisions(org_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_org_confidence
  ON ai_decisions(org_id, confidence, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_expires
  ON ai_decisions(status, expires_at);
