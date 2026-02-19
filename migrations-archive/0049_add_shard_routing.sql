-- Migration: 0049_add_shard_routing.sql
-- Purpose: Track which D1 shard each organization's platform data lives in
-- This enables horizontal scaling of campaign/metrics data across multiple D1 databases

-- Shard routing table
CREATE TABLE IF NOT EXISTS shard_routing (
    organization_id TEXT PRIMARY KEY,
    shard_id INTEGER NOT NULL DEFAULT 0,  -- 0-15 (start with 0-3)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at DATETIME,                  -- When data was copied from Supabase
    verified_at DATETIME,                  -- When data integrity was verified
    data_size_bytes INTEGER DEFAULT 0,     -- For rebalancing decisions
    campaign_count INTEGER DEFAULT 0,      -- Quick stats
    metrics_row_count INTEGER DEFAULT 0
);

CREATE INDEX idx_shard_routing_shard ON shard_routing(shard_id);
CREATE INDEX idx_shard_routing_migrated ON shard_routing(migrated_at) WHERE migrated_at IS NOT NULL;

-- Track migration progress per organization
CREATE TABLE IF NOT EXISTS shard_migration_log (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    platform TEXT NOT NULL,  -- 'google', 'facebook', 'tiktok', 'stripe'
    table_name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'supabase',
    rows_migrated INTEGER DEFAULT 0,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    error_message TEXT,
    UNIQUE(organization_id, platform, table_name)
);

CREATE INDEX idx_migration_log_org ON shard_migration_log(organization_id);
CREATE INDEX idx_migration_log_status ON shard_migration_log(completed_at) WHERE completed_at IS NULL;
