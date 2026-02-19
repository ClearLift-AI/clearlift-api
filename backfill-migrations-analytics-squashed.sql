-- Backfill d1_migrations for ANALYTICS_DB
-- Run this against remote D1 to mark all migrations as applied
-- Use this when bootstrapping from squashed base + incremental migrations
-- WARNING: This deletes existing migration records!

DELETE FROM d1_migrations;

-- =========================================================================
-- Squashed base migrations (0001-0036)
-- These replaced the original 0001-0039 pre-squash migrations
-- =========================================================================
INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_core_metrics.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0002_event_summaries.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0003_unified_ad_platforms.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0004_unified_crm.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0005_unified_comm.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0006_unified_ecommerce.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0007_unified_payments.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0008_unified_support.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0009_unified_scheduling.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0010_unified_forms.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0011_unified_events.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0012_unified_analytics.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0013_unified_accounting.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0014_unified_attribution.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0015_unified_reviews.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0016_unified_affiliate.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0017_unified_social.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0018_conversions.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0019_goal_conversions.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0020_customer_identities.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0021_journeys.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0022_attribution_results.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0023_tracked_clicks.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0024_tracking_links.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0025_utm.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0026_funnel_transitions.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0027_stripe.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0028_shopify.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0029_jobber.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0030_facebook_pages.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0031_pre_aggregation.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0032_reconciliation.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0033_cac_history.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0034_handoff.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0035_analytics_infra.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0036_drop_dead_tables.sql', datetime('now'));

-- =========================================================================
-- Old pre-squash migrations (still on disk, content in squashed base)
-- Must be registered so wrangler doesn't try to re-apply them
-- =========================================================================
INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_create_analytics_schema.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0002_simplify_to_aggregates.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0003_add_ad_platform_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0004_core_analytics_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0005_utm_links_reconciliation.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0006_shopify_jobber.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0007_add_facebook_pages.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0008_add_refund_tracking.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0009_add_subscription_metrics.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0010_add_deduplication.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0011_add_billing_reason.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0012_add_by_page_column.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0013_add_funnel_transitions.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0014_restore_customer_identities.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0015_add_compound_indexes.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0016_fix_dedup_constraint.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0017_add_conversion_linking.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0018_journey_analytics_table.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0019_unified_ad_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0020_unified_crm_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0021_unified_comm_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0022_unified_ecommerce_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0023_unified_payments_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0024_unified_support_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0025_unified_scheduling_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0026_unified_forms_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0027_unified_events_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0028_unified_analytics_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0029_unified_accounting_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0030_unified_attribution_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0031_unified_reviews_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0032_unified_affiliate_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0033_unified_social_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0034_enhance_identity_graph.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0035_multi_conversion_support.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0036_add_unified_event_type.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0037_attribution_gap_fixes.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0038_pre_aggregation_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0039_migrate_cac_history.sql', datetime('now'));

-- =========================================================================
-- Post-squash incremental migrations (0040-0048)
-- =========================================================================
INSERT INTO d1_migrations (name, applied_at) VALUES ('0040_goal_conversions_dedup.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0041_add_conversion_attribution_unique.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0042_add_conversion_refund_tracking.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0043_cac_history_per_source.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0044_reconcile_journey_analytics.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0045_ad_metrics_updated_at.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0046_handoff_patterns.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0047_drop_legacy_platform_tables.sql', datetime('now'));
INSERT INTO d1_migrations (name, applied_at) VALUES ('0048_connector_tables.sql', datetime('now'));
