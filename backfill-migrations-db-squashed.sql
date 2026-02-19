-- Backfill d1_migrations for DB
-- Run this against remote D1 to mark all migrations as applied
-- Use this when bootstrapping from squashed base + incremental migrations
-- WARNING: This deletes existing migration records!

DELETE FROM d1_migrations;

-- =========================================================================
-- Squashed base migrations (0001-0020)
-- These contain the complete schema as of the Feb 2026 squash
-- =========================================================================
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
INSERT INTO d1_migrations (name, applied_at) VALUES ('0020_drop_dead_tables.sql', datetime('now'));

-- =========================================================================
-- Post-squash incremental migrations (0021-0084)
-- Content already in squashed base; registered so wrangler skips them
-- =========================================================================
INSERT INTO d1_migrations (name, applied_at) VALUES ('0021_make_audit_user_id_nullable.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0022_add_org_tracking_configs.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0023_add_event_sync_watermarks.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0024_remove_sync_jobs_connection_fk.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0025_add_missing_audit_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0026_add_password_authentication.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0027_add_consent_configurations.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0028_add_rate_limits.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0029_add_identity_mappings.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0030_add_attribution_settings.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0031_fix_invitations_table.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0032_add_tracking_domains.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0033_add_conversion_goals.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0034_add_global_events_watermark.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0035_add_org_conversion_source.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0036_add_custom_instructions.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0037_add_llm_settings.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0038_add_attentive_connector_config.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0039_add_stripe_metadata_keys.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0040_add_active_event_workflows.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0041_add_tracking_links.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0042_add_terms_acceptance.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0043_add_user_is_admin.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0044_add_admin_invites.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0045_add_shopify_connector_config.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0046_add_active_shopify_workflows.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0047_add_jobber_connector_config.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0048_add_disabled_conversion_sources.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0049_add_shard_routing.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0050_add_data_source_routing.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0051_add_admin_tasks.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0052_add_needs_reauth.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0053_add_business_type.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0054_add_conversion_goals.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0055_add_goal_value_formula.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0056_add_sync_progress_tracking.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0060_add_goal_hierarchy.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0065_flow_builder_support.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0066_add_payment_connectors.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0067_connector_registry.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0068_seed_connector_registry.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0069_seed_extended_connectors.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0070_cleanup_event_filters.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0071_add_script_hashes.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0072_add_funnel_branching.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0073_add_multi_conversion.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0074_flow_builder_v2.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0075_add_unified_event_type.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0076_extend_onboarding_tracking.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0077_add_webhook_endpoints.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0078_add_dashboard_layouts.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0079_add_sync_jobs_cleanup_index.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0080_add_goal_source_conditions.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0081_drop_dead_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0082_backfill_org_tag_mapping_ids.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0083_add_step_requirement.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0084_meta_action_type_events.sql', datetime('now'));
