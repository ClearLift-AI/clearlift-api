-- Grouped migration: sharding
-- Tables: shard_routing

-- Table: shard_routing
CREATE TABLE shard_routing (
  organization_id TEXT PRIMARY KEY,
  shard_id INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  migrated_at DATETIME,
  verified_at DATETIME,
  data_size_bytes INTEGER DEFAULT 0,
  campaign_count INTEGER DEFAULT 0,
  metrics_row_count INTEGER DEFAULT 0,
  read_source TEXT NOT NULL DEFAULT 'supabase' CHECK (read_source IN ('supabase', 'd1')),
  write_mode TEXT NOT NULL DEFAULT 'supabase' CHECK (write_mode IN ('supabase', 'dual', 'd1')),
  d1_enabled_at DATETIME,
  last_error TEXT,
  error_count INTEGER DEFAULT 0
);

-- Indexes for shard_routing
CREATE INDEX idx_shard_routing_migrated ON shard_routing(migrated_at) WHERE migrated_at IS NOT NULL;
CREATE INDEX idx_shard_routing_read_source ON shard_routing(read_source);
CREATE INDEX idx_shard_routing_shard ON shard_routing(shard_id);
CREATE INDEX idx_shard_routing_write_mode ON shard_routing(write_mode);
