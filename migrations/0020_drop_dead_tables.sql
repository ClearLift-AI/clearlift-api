-- Phase 1: Drop dead DB tables (0 code references)
-- Part of Schema v2 cleanup (Feb 2026)
-- These tables were created but never had readers or writers implemented.

-- Infrastructure tables never implemented
DROP TABLE IF EXISTS audit_retention_policy;
DROP TABLE IF EXISTS cleanup_jobs;

-- Superseded by event_sync_watermarks
DROP TABLE IF EXISTS global_events_watermark;

-- One-time shard migration tracker, never used
DROP TABLE IF EXISTS shard_migration_log;

-- Webhook delivery audit trail, never implemented (webhook_events IS used)
DROP TABLE IF EXISTS webhook_delivery_log;
