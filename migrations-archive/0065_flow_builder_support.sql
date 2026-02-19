-- Flow Builder Support Migration
-- Adds fields to support the new unified Acquisition Flow Builder

-- 1. Add connector field (which data source this goal uses)
ALTER TABLE conversion_goals ADD COLUMN connector TEXT;

-- 2. Add isConversion flag (any stage can mark conversions)
ALTER TABLE conversion_goals ADD COLUMN is_conversion INTEGER DEFAULT 0;

-- 3. Add position for advanced mode graph layout
ALTER TABLE conversion_goals ADD COLUMN position_col INTEGER DEFAULT 0;
ALTER TABLE conversion_goals ADD COLUMN position_row INTEGER;

-- 4. Add connector-specific event type
ALTER TABLE conversion_goals ADD COLUMN connector_event_type TEXT;

-- 5. Backfill connector from existing goal_type
UPDATE conversion_goals SET connector = 'clearlift_tag' WHERE goal_type = 'tag_event';
UPDATE conversion_goals SET connector = 'stripe' WHERE goal_type = 'revenue_source' AND revenue_sources LIKE '%stripe%';
UPDATE conversion_goals SET connector = 'shopify' WHERE goal_type = 'revenue_source' AND revenue_sources LIKE '%shopify%';
UPDATE conversion_goals SET connector = 'jobber' WHERE goal_type = 'revenue_source' AND revenue_sources LIKE '%jobber%';

-- 6. Backfill is_conversion from type
UPDATE conversion_goals SET is_conversion = 1 WHERE type = 'conversion';

-- 7. Backfill position_row from funnel relationships
UPDATE conversion_goals SET position_row = (
  SELECT COALESCE(MAX(funnel_position), 0)
  FROM goal_relationships
  WHERE upstream_goal_id = conversion_goals.id OR downstream_goal_id = conversion_goals.id
);

-- 8. Add flow_mode to organizations
ALTER TABLE organizations ADD COLUMN flow_mode TEXT DEFAULT 'simple';
