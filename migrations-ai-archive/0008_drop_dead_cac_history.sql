-- =============================================================================
-- 0008: DROP dead cac_history from AI_DB
-- =============================================================================
-- cac_history was originally created here (0005) and extended (0006),
-- but migration 0039 in ANALYTICS_DB migrated it to the canonical location.
-- All code (4 API files, 1 cron file) uses env.ANALYTICS_DB for cac_history.
-- This copy is dead weight. cac_baselines and cac_predictions remain in AI_DB.

DROP TABLE IF EXISTS cac_history;
