-- =============================================================================
-- 0047: DROP 16 legacy platform-specific tables
-- =============================================================================
-- These tables were created by 0001_platform_tables.sql but all sync workflows
-- now write exclusively to unified tables (ad_campaigns, ad_groups, ads, ad_metrics)
-- via D1UnifiedService. Zero active callers remain for any of these 16 tables.
--
-- NOT dropped: facebook_pages (still actively written by facebook-ads-sync and
-- read by API facebook.ts endpoints — no unified equivalent exists yet).

-- Google Ads (6 tables)
DROP TABLE IF EXISTS google_campaigns;
DROP TABLE IF EXISTS google_ad_groups;
DROP TABLE IF EXISTS google_ads;
DROP TABLE IF EXISTS google_campaign_daily_metrics;
DROP TABLE IF EXISTS google_ad_group_daily_metrics;
DROP TABLE IF EXISTS google_ad_daily_metrics;

-- Meta / Facebook Ads (5 tables — facebook_pages intentionally kept)
DROP TABLE IF EXISTS facebook_campaigns;
DROP TABLE IF EXISTS facebook_ad_sets;
DROP TABLE IF EXISTS facebook_ads;
DROP TABLE IF EXISTS facebook_campaign_daily_metrics;
DROP TABLE IF EXISTS facebook_ad_set_daily_metrics;
DROP TABLE IF EXISTS facebook_ad_daily_metrics;

-- TikTok Ads (4 tables)
DROP TABLE IF EXISTS tiktok_campaigns;
DROP TABLE IF EXISTS tiktok_ad_groups;
DROP TABLE IF EXISTS tiktok_ads;
DROP TABLE IF EXISTS tiktok_campaign_daily_metrics;
