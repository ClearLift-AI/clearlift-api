-- =============================================================================
-- 0006: Add goal-linked conversion columns to cac_history
-- =============================================================================
-- Closes the CAC ↔ Conversion Goals loop by tracking both goal-linked and
-- platform-reported conversions separately, allowing the dashboard to show
-- goal-verified CAC when conversion goals are configured.

ALTER TABLE cac_history ADD COLUMN conversions_goal INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN conversions_platform INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN conversion_source TEXT DEFAULT 'platform';
ALTER TABLE cac_history ADD COLUMN goal_ids TEXT DEFAULT NULL;
ALTER TABLE cac_history ADD COLUMN revenue_goal_cents INTEGER DEFAULT 0;
