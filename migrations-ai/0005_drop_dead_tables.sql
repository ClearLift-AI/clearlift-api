-- Phase 1: Drop dead AI_DB tables (0 code references)
-- Part of Schema v2 cleanup (Feb 2026)

-- Per-org AI config table, never implemented (ai_optimization_settings in DB is used instead)
DROP TABLE IF EXISTS ai_org_configs;
