-- Backfill d1_migrations for AI_DB
-- Run this against remote D1 to mark all migrations as applied
-- Use this when bootstrapping from squashed base + incremental migrations
-- WARNING: This deletes existing migration records!

DELETE FROM d1_migrations;

-- =========================================================================
-- Squashed base migrations (0001-0005)
-- These contain the complete AI schema as of the Feb 2026 squash
-- =========================================================================
INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_ai_decisions.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0002_analysis.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0003_attribution_models.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0004_cac.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0005_drop_dead_tables.sql', datetime('now'));

-- =========================================================================
-- Post-squash incremental migrations (0006-0008)
-- Content already in squashed base; registered so wrangler skips them
-- =========================================================================
INSERT INTO d1_migrations (name, applied_at) VALUES ('0006_cac_goal_columns.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0007_cleanup_orphan_workflow_instance.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0008_drop_dead_cac_history.sql', datetime('now'));
