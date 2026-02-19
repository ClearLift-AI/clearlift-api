-- ============================================================================
-- MIGRATION 0007: Clean up orphan workflow_instance remnants
-- ============================================================================
-- Production AI_DB has an orphan migration (0003_workflow_instance.sql) that
-- was applied then deleted from the repository. It left behind:
--   - ai_decisions.workflow_instance_id column
--   - idx_ai_decisions_workflow_instance index
--
-- This migration removes both using the table rebuild pattern (safe whether
-- or not the orphan column exists). On local (where the column was never
-- added) this is an idempotent rebuild with identical schema.
--
-- Note: The orphan d1_migrations record stays — D1 doesn't support
-- DELETE FROM d1_migrations and the stale row is harmless.
-- ============================================================================

-- Drop the orphan index (IF EXISTS handles both environments)
DROP INDEX IF EXISTS idx_ai_decisions_workflow_instance;

-- Rebuild ai_decisions with only the canonical columns.
-- This is safe on both local (column absent) and production (column present)
-- because the SELECT explicitly lists only the columns we want to keep.
CREATE TABLE ai_decisions_new (
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

INSERT INTO ai_decisions_new (
  id, organization_id, tool, platform, entity_type, entity_id, entity_name,
  parameters, current_state, reason, predicted_impact, confidence,
  supporting_data, status, expires_at, created_at, reviewed_at, reviewed_by,
  executed_at, execution_result, error_message, actual_impact, measured_at,
  simulation_data, simulation_confidence
)
SELECT
  id, organization_id, tool, platform, entity_type, entity_id, entity_name,
  parameters, current_state, reason, predicted_impact, confidence,
  supporting_data, status, expires_at, created_at, reviewed_at, reviewed_by,
  executed_at, execution_result, error_message, actual_impact, measured_at,
  simulation_data, simulation_confidence
FROM ai_decisions;

-- Drop all existing indexes on old table
DROP INDEX IF EXISTS idx_decisions_entity;
DROP INDEX IF EXISTS idx_decisions_org_status;
DROP INDEX IF EXISTS idx_decisions_org_pending;

DROP TABLE ai_decisions;
ALTER TABLE ai_decisions_new RENAME TO ai_decisions;

-- Recreate canonical indexes (from 0002_analysis_tables.sql)
CREATE INDEX idx_decisions_org_status ON ai_decisions(organization_id, status);
CREATE INDEX idx_decisions_org_pending ON ai_decisions(organization_id, status, expires_at)
  WHERE status = 'pending';
CREATE INDEX idx_decisions_entity ON ai_decisions(organization_id, entity_type, entity_id);
