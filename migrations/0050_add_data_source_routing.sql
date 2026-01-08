-- Migration: 0050_add_data_source_routing.sql
-- Purpose: Add per-org routing flags for gradual D1 rollout
-- Allows switching individual orgs between Supabase and D1

-- read_source: where to read platform data from
--   'supabase' = read from Supabase (default, current behavior)
--   'd1' = read from D1 shard
ALTER TABLE shard_routing ADD COLUMN read_source TEXT NOT NULL DEFAULT 'supabase'
    CHECK (read_source IN ('supabase', 'd1'));

-- write_mode: where to write platform data
--   'supabase' = write to Supabase only (default, current behavior)
--   'dual' = write to both Supabase and D1 (migration period)
--   'd1' = write to D1 only (fully migrated)
ALTER TABLE shard_routing ADD COLUMN write_mode TEXT NOT NULL DEFAULT 'supabase'
    CHECK (write_mode IN ('supabase', 'dual', 'd1'));

-- Track when org was switched to D1 reads
ALTER TABLE shard_routing ADD COLUMN d1_enabled_at DATETIME;

-- Track any issues for monitoring
ALTER TABLE shard_routing ADD COLUMN last_error TEXT;
ALTER TABLE shard_routing ADD COLUMN error_count INTEGER DEFAULT 0;

-- Index for finding orgs using D1
CREATE INDEX idx_shard_routing_read_source ON shard_routing(read_source);
CREATE INDEX idx_shard_routing_write_mode ON shard_routing(write_mode);
