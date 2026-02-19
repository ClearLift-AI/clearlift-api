-- ============================================================================
-- MIGRATION: Simplify to Aggregates Only
-- ============================================================================
-- D1 stores ONLY aggregated metrics per org
-- Raw events and touchpoints stay in R2 (query via R2 SQL when needed)
-- ============================================================================

-- Drop tables we don't need (individual event-level data)
DROP TABLE IF EXISTS touchpoints;
DROP TABLE IF EXISTS customer_identities;

-- Keep only aggregate tables:
-- - hourly_metrics
-- - daily_metrics
-- - utm_performance
-- - journeys (aggregated paths, not individual touchpoints)
-- - channel_transitions (Markov matrix)
-- - attribution_results
-- - sync_watermarks

-- ============================================================================
-- Add org_tag index optimization for all aggregate tables
-- ============================================================================

-- Ensure we have good indexes for org + time range queries
DROP INDEX IF EXISTS idx_hm_org_hour;
CREATE INDEX IF NOT EXISTS idx_hm_org_hour ON hourly_metrics(org_tag, hour DESC);

DROP INDEX IF EXISTS idx_dm_org_date;
CREATE INDEX IF NOT EXISTS idx_dm_org_date ON daily_metrics(org_tag, date DESC);

DROP INDEX IF EXISTS idx_utm_org_date;
CREATE INDEX IF NOT EXISTS idx_utm_org_date ON utm_performance(org_tag, date DESC);

-- ============================================================================
-- Add retention cleanup helper
-- ============================================================================
-- D1 doesn't have pg_cron, so cleanup is done via scheduled workflow

-- Track cleanup progress
CREATE TABLE IF NOT EXISTS cleanup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  org_tag TEXT,
  records_deleted INTEGER DEFAULT 0,
  retention_days INTEGER NOT NULL,
  run_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Summary of final schema
-- ============================================================================
--
-- AGGREGATES (populated by AggregationWorkflow):
-- - hourly_metrics: Hourly rollups by org
-- - daily_metrics: Daily rollups by org (with channel/device/geo breakdowns)
-- - utm_performance: UTM campaign performance by org + date
--
-- ATTRIBUTION (populated by AttributionWorkflow):
-- - journeys: Aggregated channel paths leading to conversions
-- - channel_transitions: Markov transition matrix
-- - attribution_results: Final Markov/Shapley attribution credits
--
-- OPERATIONAL:
-- - sync_watermarks: Track sync progress
-- - cleanup_log: Track retention cleanup
--
-- RAW DATA (in R2, query via R2 SQL):
-- - clearlift.event_data: All raw events with 100+ fields
-- - Accessed when dashboard needs event-level details
