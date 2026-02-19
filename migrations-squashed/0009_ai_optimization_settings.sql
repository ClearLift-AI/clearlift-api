-- Table: ai_optimization_settings
CREATE TABLE ai_optimization_settings (
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
  conversion_source TEXT DEFAULT 'tag' CHECK(conversion_source IN ('ad_platforms', 'tag', 'connectors')),
  custom_instructions TEXT,
  llm_default_provider TEXT DEFAULT 'auto',
  llm_claude_model TEXT DEFAULT 'haiku',
  llm_gemini_model TEXT DEFAULT 'flash',
  llm_max_recommendations INTEGER DEFAULT 3,
  llm_enable_exploration INTEGER DEFAULT 1,
  disabled_conversion_sources TEXT DEFAULT '[]',
  business_type TEXT DEFAULT 'lead_gen' CHECK(business_type IN ('ecommerce', 'lead_gen', 'saas')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for ai_optimization_settings
CREATE INDEX idx_ai_optimization_settings_business_type ON ai_optimization_settings(org_id, business_type);
CREATE INDEX idx_ai_settings_conversion_source ON ai_optimization_settings(conversion_source);
CREATE INDEX idx_ai_settings_last_recommendation ON ai_optimization_settings(last_recommendation_at, budget_optimization);
