-- ClearLift AI Database Schema
-- Clean single-file schema for the AI recommendation engine

-- =============================================================================
-- AI_DECISIONS
-- =============================================================================
-- One row = one recommendation. Contains: what, why, when, and outcome.

CREATE TABLE ai_decisions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- WHAT: The action to take
  tool TEXT NOT NULL,  -- set_budget, set_status, set_age_range, set_bid_strategy
  platform TEXT NOT NULL,  -- facebook, google, tiktok
  entity_type TEXT NOT NULL,  -- campaign, ad_set, ad_group, ad
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',  -- { "amount_cents": 15000, "budget_type": "daily" }
  current_state TEXT DEFAULT '{}',  -- { "daily_budget": 10000 } for undo

  -- WHY: The reasoning
  reason TEXT NOT NULL,
  predicted_impact REAL,  -- -15.5 = 15.5% CaC reduction
  confidence TEXT NOT NULL DEFAULT 'medium',  -- low, medium, high
  supporting_data TEXT DEFAULT '{}',  -- metrics that led to this

  -- WHEN: Lifecycle
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, executed, failed, expired
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  executed_at TEXT,

  -- OUTCOME: Results & feedback
  execution_result TEXT,
  error_message TEXT,
  actual_impact REAL,
  measured_at TEXT
);

CREATE INDEX idx_decisions_org_pending ON ai_decisions(organization_id, status, expires_at)
  WHERE status = 'pending';
CREATE INDEX idx_decisions_org_status ON ai_decisions(organization_id, status, created_at DESC);
CREATE INDEX idx_decisions_entity ON ai_decisions(platform, entity_id);


-- =============================================================================
-- AI_TOOL_REGISTRY
-- =============================================================================
-- Available tools per platform with constraints

CREATE TABLE ai_tool_registry (
  tool TEXT NOT NULL,
  platform TEXT NOT NULL,
  entity_types TEXT NOT NULL DEFAULT '[]',  -- ["campaign", "ad_set"]
  parameter_schema TEXT NOT NULL DEFAULT '{}',
  constraints TEXT NOT NULL DEFAULT '{}',  -- { "max_change_percent": 50 }
  api_endpoint TEXT,
  is_enabled INTEGER DEFAULT 1,
  PRIMARY KEY (tool, platform)
);

-- Seed tools
INSERT INTO ai_tool_registry (tool, platform, entity_types, constraints, api_endpoint) VALUES
  ('set_budget', 'facebook', '["campaign","ad_set"]', '{"max_change_percent":50,"min_cents":100}', '/v1/analytics/facebook/{entity_type}s/{entity_id}/budget'),
  ('set_budget', 'google', '["campaign"]', '{"max_change_percent":50}', '/v1/analytics/google/campaigns/{entity_id}/budget'),
  ('set_budget', 'tiktok', '["campaign","ad_group"]', '{"max_change_percent":50,"min_cents":2000}', '/v1/analytics/tiktok/{entity_type}s/{entity_id}/budget'),
  ('set_status', 'facebook', '["campaign","ad_set","ad"]', '{}', '/v1/analytics/facebook/{entity_type}s/{entity_id}/status'),
  ('set_status', 'google', '["campaign","ad_group","ad"]', '{}', '/v1/analytics/google/{entity_type}s/{entity_id}/status'),
  ('set_status', 'tiktok', '["campaign","ad_group","ad"]', '{}', '/v1/analytics/tiktok/{entity_type}s/{entity_id}/status'),
  ('set_age_range', 'facebook', '["ad_set"]', '{"min":18,"max":65}', '/v1/analytics/facebook/ad-sets/{entity_id}/targeting');


-- =============================================================================
-- AI_ORG_CONFIGS
-- =============================================================================
-- Per-organization AI settings

CREATE TABLE ai_org_configs (
  organization_id TEXT PRIMARY KEY,
  is_enabled INTEGER DEFAULT 1,
  auto_execute INTEGER DEFAULT 0,
  min_confidence TEXT DEFAULT 'medium',  -- minimum to show
  decision_ttl_days INTEGER DEFAULT 7,
  max_daily_decisions INTEGER DEFAULT 20,
  max_auto_budget_change_pct INTEGER DEFAULT 20,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
