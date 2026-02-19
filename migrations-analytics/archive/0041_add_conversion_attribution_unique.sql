-- Add UNIQUE constraint to conversion_attribution to prevent duplicates on reprocessing.
-- Natural key: one attribution record per (org, conversion, model, touchpoint_position).
-- This backs the existing ON CONFLICT DO NOTHING in click-extraction.ts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_unique
ON conversion_attribution(organization_id, conversion_id, model, touchpoint_position);
