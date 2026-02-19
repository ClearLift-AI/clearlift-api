-- Conversion Goals Enhancement
-- Adds new columns to existing conversion_goals table for multi-source goals
-- Backwards compatible with existing trigger_config based goals

-- Add new columns to existing conversion_goals table
-- These enable the new revenue source plugin system while preserving legacy goals

-- slug: URL-safe identifier
ALTER TABLE conversion_goals ADD COLUMN slug TEXT;

-- description: Optional description
ALTER TABLE conversion_goals ADD COLUMN description TEXT;

-- goal_type: Where data comes from (revenue_source, tag_event, manual, or legacy)
ALTER TABLE conversion_goals ADD COLUMN goal_type TEXT DEFAULT 'tag_event';

-- revenue_sources: JSON array of platforms for revenue_source goals
ALTER TABLE conversion_goals ADD COLUMN revenue_sources TEXT;

-- event_filters: JSON object with filters for tag_event goals (replaces trigger_config)
ALTER TABLE conversion_goals ADD COLUMN event_filters_v2 TEXT;

-- value_type: How to calculate conversion value
ALTER TABLE conversion_goals ADD COLUMN value_type TEXT DEFAULT 'from_source';

-- fixed_value_cents: Used when value_type = 'fixed'
ALTER TABLE conversion_goals ADD COLUMN fixed_value_cents INTEGER;

-- display_order: Order in UI (lower = first) - already have priority, add alias
ALTER TABLE conversion_goals ADD COLUMN display_order INTEGER DEFAULT 0;

-- color: Hex color for charts
ALTER TABLE conversion_goals ADD COLUMN color TEXT;

-- icon: Icon identifier
ALTER TABLE conversion_goals ADD COLUMN icon TEXT;

-- is_active: Status flag
ALTER TABLE conversion_goals ADD COLUMN is_active INTEGER DEFAULT 1;

-- Create index for the new goal_type column
CREATE INDEX IF NOT EXISTS idx_conversion_goals_goal_type ON conversion_goals(organization_id, goal_type);

-- Create unique index for slug (using partial index to allow NULL slugs for legacy)
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversion_goals_slug ON conversion_goals(organization_id, slug) WHERE slug IS NOT NULL;

-- Update existing goals with sensible defaults:
-- - Set goal_type to 'tag_event' (they use trigger_config)
-- - Generate slug from name
-- - Set value_type based on default_value_cents
UPDATE conversion_goals
SET
  goal_type = 'tag_event',
  value_type = CASE
    WHEN default_value_cents > 0 THEN 'fixed'
    ELSE 'from_source'
  END,
  fixed_value_cents = CASE
    WHEN default_value_cents > 0 THEN default_value_cents
    ELSE NULL
  END,
  display_order = priority,
  is_active = 1
WHERE goal_type IS NULL;

-- Note: Slugs for existing goals should be generated in application code
-- to ensure proper URL-safe formatting
