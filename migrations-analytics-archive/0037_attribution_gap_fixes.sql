-- Migration 0037: Attribution gap fixes
-- Adds UNIQUE constraint on tracked_clicks to prevent duplicate click ingestion
-- Adds link_method and link_confidence columns to goal_conversions

-- Unique constraint on tracked_clicks (partial index: only where click_id is not null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_clicks_unique
  ON tracked_clicks(organization_id, click_id, click_timestamp)
  WHERE click_id IS NOT NULL;

-- Add link_method and link_confidence to goal_conversions for ConversionLinkingWorkflow data
ALTER TABLE goal_conversions ADD COLUMN link_method TEXT;
ALTER TABLE goal_conversions ADD COLUMN link_confidence REAL;
