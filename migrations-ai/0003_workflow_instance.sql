-- Migration: Add workflow_instance_id for human-in-the-loop approval flow
-- When in autopilot mode, the workflow waits for approval events
-- This column stores the workflow instance ID to route approval events

ALTER TABLE ai_decisions ADD COLUMN workflow_instance_id TEXT;

-- Index for looking up decisions by workflow instance
CREATE INDEX IF NOT EXISTS idx_ai_decisions_workflow_instance
ON ai_decisions(workflow_instance_id)
WHERE workflow_instance_id IS NOT NULL;
