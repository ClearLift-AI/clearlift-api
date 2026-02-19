-- Migration: Add by_page JSON column to hourly_metrics
-- This allows tracking page view breakdowns similar to by_channel and by_device

ALTER TABLE hourly_metrics ADD COLUMN by_page TEXT;

-- Index for faster queries on by_page when filtering by org
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_by_page ON hourly_metrics(org_tag, hour) WHERE by_page IS NOT NULL;
