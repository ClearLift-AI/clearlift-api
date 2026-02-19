-- Migration: Add dedup index to goal_conversions
-- The table had no unique constraint on (org, goal, event), so each
-- AggregationWorkflow run re-inserted duplicates. Delete existing dupes
-- first, then add the index to prevent future ones.

-- Step 1: Remove duplicate rows, keeping the earliest by rowid
DELETE FROM goal_conversions
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM goal_conversions
  GROUP BY organization_id, goal_id, source_event_id
);

-- Step 2: Add unique index to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_conversions_dedup
  ON goal_conversions(organization_id, goal_id, source_event_id);
