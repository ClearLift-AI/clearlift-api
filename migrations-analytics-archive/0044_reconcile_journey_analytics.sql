-- ============================================================================
-- MIGRATION 0044: Reconcile journey_analytics schema drift
-- ============================================================================
-- Production journey_analytics has constraint drift vs the canonical schema
-- defined in 0018. SQLite cannot ALTER column constraints, so we rebuild
-- the table using the standard rename-copy-drop pattern.
--
-- Drift fixed:
--   entry_channels, exit_channels, transition_matrix, common_paths:
--     prod is nullable → canonical is NOT NULL
--   total_sessions, converting_sessions:
--     prod missing DEFAULT 0 → canonical has NOT NULL DEFAULT 0
--   conversion_rate, avg_path_length:
--     prod is NOT NULL with no default → canonical is nullable DEFAULT 0
--   data_quality_level:
--     prod is NOT NULL → canonical is nullable DEFAULT 1
--   created_at:
--     missing on prod → added with DEFAULT datetime('now')
--   idx_journey_analytics_org_period:
--     extra index on prod → dropped (redundant with idx_journey_analytics_period)
-- ============================================================================

-- Step 1: Create new table with canonical schema (matches 0018)
CREATE TABLE IF NOT EXISTS journey_analytics_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,

  -- Channel Analytics
  channel_distribution TEXT NOT NULL,
  entry_channels TEXT NOT NULL,
  exit_channels TEXT NOT NULL,
  transition_matrix TEXT NOT NULL,

  -- Session Metrics
  total_sessions INTEGER NOT NULL DEFAULT 0,
  converting_sessions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL DEFAULT 0,
  avg_path_length REAL DEFAULT 0,

  -- Path Analysis
  common_paths TEXT NOT NULL,

  -- Data Quality
  data_quality_level INTEGER DEFAULT 1,
  data_quality_report TEXT,

  -- Conversion Matching
  total_conversions INTEGER DEFAULT 0,
  matched_conversions INTEGER DEFAULT 0,
  match_breakdown TEXT,

  -- Time Period
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,

  -- Timestamps
  computed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),

  -- Unique constraint for upsert
  UNIQUE(org_tag, period_start, period_end)
);

-- Step 2: Copy data, providing defaults for constraint changes
-- COALESCE ensures NOT NULL columns get safe defaults from nullable prod data
INSERT INTO journey_analytics_new (
  id, org_tag, channel_distribution,
  entry_channels, exit_channels, transition_matrix,
  total_sessions, converting_sessions, conversion_rate, avg_path_length,
  common_paths, data_quality_level, data_quality_report,
  total_conversions, matched_conversions, match_breakdown,
  period_start, period_end, computed_at, created_at
)
SELECT
  id, org_tag, channel_distribution,
  COALESCE(entry_channels, '{}'),
  COALESCE(exit_channels, '{}'),
  COALESCE(transition_matrix, '{}'),
  COALESCE(total_sessions, 0),
  COALESCE(converting_sessions, 0),
  COALESCE(conversion_rate, 0),
  COALESCE(avg_path_length, 0),
  COALESCE(common_paths, '[]'),
  data_quality_level,
  data_quality_report,
  total_conversions, matched_conversions, match_breakdown,
  period_start, period_end, computed_at,
  COALESCE(computed_at, datetime('now'))  -- backfill created_at from computed_at
FROM journey_analytics;

-- Step 3: Drop old table (also drops idx_journey_analytics_org_period and others)
DROP TABLE journey_analytics;

-- Step 4: Rename new table
ALTER TABLE journey_analytics_new RENAME TO journey_analytics;

-- Step 5: Recreate canonical indexes (from 0018)
CREATE INDEX IF NOT EXISTS idx_journey_analytics_org
  ON journey_analytics(org_tag);

CREATE INDEX IF NOT EXISTS idx_journey_analytics_period
  ON journey_analytics(org_tag, period_start DESC, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_journey_analytics_quality
  ON journey_analytics(org_tag, data_quality_level);
