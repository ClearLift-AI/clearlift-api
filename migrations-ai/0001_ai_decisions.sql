-- Grouped migration: ai_decisions
-- Tables: ai_decisions, ai_org_configs, ai_tool_registry

-- Table: ai_decisions
CREATE TABLE "ai_decisions" (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  platform TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  current_state TEXT DEFAULT '{}',
  reason TEXT NOT NULL,
  predicted_impact REAL,
  confidence TEXT NOT NULL DEFAULT 'medium',
  supporting_data TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  executed_at TEXT,
  execution_result TEXT,
  error_message TEXT,
  actual_impact REAL,
  measured_at TEXT,
  simulation_data TEXT,
  simulation_confidence TEXT
);

-- Indexes for ai_decisions
CREATE INDEX idx_decisions_entity ON ai_decisions(organization_id, entity_type, entity_id);
CREATE INDEX idx_decisions_org_pending ON ai_decisions(organization_id, status, expires_at) WHERE status = 'pending';
CREATE INDEX idx_decisions_org_status ON ai_decisions(organization_id, status);

-- Table: ai_org_configs
CREATE TABLE ai_org_configs (
  organization_id TEXT PRIMARY KEY,
  is_enabled INTEGER DEFAULT 1,
  auto_execute INTEGER DEFAULT 0,
  min_confidence TEXT DEFAULT 'medium',
  decision_ttl_days INTEGER DEFAULT 7,
  max_daily_decisions INTEGER DEFAULT 20,
  max_auto_budget_change_pct INTEGER DEFAULT 20,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Table: ai_tool_registry
CREATE TABLE ai_tool_registry (
  tool TEXT NOT NULL,
  platform TEXT NOT NULL,
  entity_types TEXT NOT NULL DEFAULT '[]',
  parameter_schema TEXT NOT NULL DEFAULT '{}',
  constraints TEXT NOT NULL DEFAULT '{}',
  api_endpoint TEXT,
  is_enabled INTEGER DEFAULT 1,
  PRIMARY KEY (tool, platform)
);
