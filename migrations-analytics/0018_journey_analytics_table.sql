-- ============================================================================
-- MIGRATION 0018: Journey Analytics Table
-- ============================================================================
-- Creates the journey_analytics table for storing aggregated journey metrics
-- computed by the ProbabilisticAttributionWorkflow.
--
-- This table stores:
-- - Channel distribution and transition patterns
-- - Session and conversion metrics
-- - Data quality reports
-- - Period-based analytics (can be recomputed for different date ranges)
-- ============================================================================

CREATE TABLE IF NOT EXISTS journey_analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,

  -- Channel Analytics
  channel_distribution TEXT NOT NULL,  -- JSON: {channel: percentage}
  entry_channels TEXT NOT NULL,        -- JSON: {channel: percentage}
  exit_channels TEXT NOT NULL,         -- JSON: {channel: percentage}
  transition_matrix TEXT NOT NULL,     -- JSON: {from: {to: probability}}

  -- Session Metrics
  total_sessions INTEGER NOT NULL DEFAULT 0,
  converting_sessions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  avg_path_length REAL DEFAULT 0,

  -- Path Analysis
  common_paths TEXT NOT NULL,          -- JSON: [{path: [], count, conversion_rate}]

  -- Data Quality
  data_quality_level INTEGER DEFAULT 1,  -- 1-4 (journey_only to identity_matched)
  data_quality_report TEXT,              -- JSON: full quality report

  -- Conversion Matching
  total_conversions INTEGER DEFAULT 0,
  matched_conversions INTEGER DEFAULT 0,
  match_breakdown TEXT,                  -- JSON: {identity, time_proximity, direct_tag, goal_matched, unmatched}

  -- Time Period
  period_start TEXT NOT NULL,            -- YYYY-MM-DD
  period_end TEXT NOT NULL,              -- YYYY-MM-DD

  -- Timestamps
  computed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),

  -- Unique constraint for upsert
  UNIQUE(org_tag, period_start, period_end)
);

-- Index for efficient lookups by organization
CREATE INDEX IF NOT EXISTS idx_journey_analytics_org
  ON journey_analytics(org_tag);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_journey_analytics_period
  ON journey_analytics(org_tag, period_start DESC, period_end DESC);

-- Index for data quality filtering
CREATE INDEX IF NOT EXISTS idx_journey_analytics_quality
  ON journey_analytics(org_tag, data_quality_level);
