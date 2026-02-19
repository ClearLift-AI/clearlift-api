-- Migration: Cleanup event_filters naming confusion
--
-- Background:
-- - `event_filters` table was created but never used (orphaned)
-- - `event_filters_v2` column in conversion_goals IS the active filter config
-- - The "_v2" suffix is confusing - rename to `filter_config`
--
-- Changes:
-- 1. Rename event_filters_v2 column to filter_config
-- 2. Drop the unused event_filters table

-- Step 1: Rename column (SQLite 3.25+)
ALTER TABLE conversion_goals RENAME COLUMN event_filters_v2 TO filter_config;

-- Step 2: Drop unused standalone table
DROP TABLE IF EXISTS event_filters;
