-- AI Optimization Settings
-- Stores user preferences from the Optimization Matrix for AI-driven campaign optimization
-- Note: AI decisions/recommendations are stored in separate AI_DB database

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
