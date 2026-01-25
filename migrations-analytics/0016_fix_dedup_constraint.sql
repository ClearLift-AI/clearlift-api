-- Migration: Add secondary unique constraint on source_id for conversions table
-- Problem: ON CONFLICT doesn't match partial index when dedup_key is NULL
-- Solution: Add a safety net index on source_id to prevent duplicate source records

-- Create unique index on source_id when it's not null
-- This ensures no two conversions can have the same source record from the same platform
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_source_unique
ON conversions(organization_id, conversion_source, source_id)
WHERE source_id IS NOT NULL;
