-- Phase 1: Drop dead ANALYTICS_DB tables (0 code references)
-- Part of Schema v2 cleanup (Feb 2026)
-- 27 tables with zero references in any backend repo (API, Cron, Events).

-- ============================================================
-- Scaffolded unified tables (no sync worker, no API endpoint)
-- ============================================================

-- Accounting category (0029) - no connector shipped
DROP TABLE IF EXISTS accounting_accounts;
DROP TABLE IF EXISTS accounting_payments;

-- Affiliate category (0032) - no connector shipped
DROP TABLE IF EXISTS affiliate_payouts;

-- Analytics category (0028) - no connector shipped
DROP TABLE IF EXISTS analytics_page_views;

-- Mobile Attribution category (0030) - no connector shipped
DROP TABLE IF EXISTS attribution_cohorts;

-- Communication category (0021) - no connector shipped
DROP TABLE IF EXISTS comm_campaign_metrics;
DROP TABLE IF EXISTS comm_lists;

-- CRM identity linking - never wired up
DROP TABLE IF EXISTS crm_identity_links;

-- E-commerce detail tables - never populated
DROP TABLE IF EXISTS ecommerce_order_items;
DROP TABLE IF EXISTS ecommerce_refunds;

-- Events category (0027) - no connector shipped
DROP TABLE IF EXISTS events_recordings;

-- Payments category extras - never used (payments_transactions IS used)
DROP TABLE IF EXISTS payments_invoices;
DROP TABLE IF EXISTS payments_plans;

-- Platform conversion claims - never implemented
DROP TABLE IF EXISTS platform_conversion_claims;

-- Reviews category (0031) - no connector shipped
DROP TABLE IF EXISTS reviews_aggregates;

-- Scheduling category extras - never populated
DROP TABLE IF EXISTS scheduling_availability;

-- Social category (0033) - no connector shipped
DROP TABLE IF EXISTS social_engagements;

-- Support category (0024) - no connector shipped
DROP TABLE IF EXISTS support_messages;

-- Tracking link clicks - never implemented
DROP TABLE IF EXISTS tracking_link_clicks;

-- ============================================================
-- Pre-aggregation tables (never populated by any workflow)
-- ============================================================
DROP TABLE IF EXISTS event_daily_summary;
DROP TABLE IF EXISTS event_hourly_summary;
DROP TABLE IF EXISTS jobber_daily_summary;
DROP TABLE IF EXISTS reconciliation_daily_summary;
DROP TABLE IF EXISTS shopify_daily_summary;
DROP TABLE IF EXISTS tracking_link_daily_summary;
DROP TABLE IF EXISTS utm_daily_performance;

-- ============================================================
-- Infrastructure tables (never implemented)
-- ============================================================
DROP TABLE IF EXISTS cleanup_log;
