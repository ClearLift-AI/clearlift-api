-- Add workflow_instance_id column to ai_decisions
-- This column was referenced in the INSERT statement (aiSettings.ts) but missing from the table schema.
-- Without it, all AI recommendation inserts fail silently, preventing new decisions from being generated.
ALTER TABLE ai_decisions ADD COLUMN workflow_instance_id TEXT;
