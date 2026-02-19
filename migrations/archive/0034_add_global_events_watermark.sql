-- Migration: 0034_add_global_events_watermark.sql
-- Purpose: Add global watermark table for global events sync job
-- This is a single-row table tracking sync state for R2 -> Supabase events sync

CREATE TABLE IF NOT EXISTS global_events_watermark (
  id TEXT PRIMARY KEY DEFAULT 'global_events',  -- Single row
  last_synced_timestamp TEXT NOT NULL,          -- ISO 8601 timestamp
  last_synced_event_id TEXT,                    -- For deduplication (optional)
  records_synced_total INTEGER DEFAULT 0,       -- Cumulative count
  records_synced_last_run INTEGER DEFAULT 0,    -- Last run count
  last_sync_status TEXT CHECK (last_sync_status IN ('success', 'partial', 'failed', 'in_progress')) DEFAULT 'success',
  last_sync_error TEXT,
  sync_duration_ms INTEGER,                     -- For monitoring
  chunks_processed INTEGER,                     -- Number of 1-min chunks processed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize with 1 hour ago (conservative start)
INSERT INTO global_events_watermark (id, last_synced_timestamp, last_sync_status)
VALUES ('global_events', datetime('now', '-1 hour'), 'success')
ON CONFLICT (id) DO NOTHING;
