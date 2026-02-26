-- Backfill d1_migrations for DB
-- Run this against remote D1 to mark all squashed migrations as applied
-- WARNING: This deletes existing migration records!

DELETE FROM d1_migrations;

INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_auth.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0002_organizations.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0003_invitations.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0004_onboarding.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0005_platform_connections.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0006_connector_configs.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0007_tag_tracking.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0008_conversion_goals.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0009_ai_optimization_settings.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0010_sync_infra.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0011_webhooks.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0012_admin.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0013_audit.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0014_identity.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0015_sharding.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0016_dashboard_layouts.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0017_rate_limits.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0018_stripe_metadata_keys.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0019_waitlist.sql', datetime('now'));
