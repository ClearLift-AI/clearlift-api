-- Add conversion_source field to ai_optimization_settings
-- This determines which conversion tracking method is used for CAC calculations:
--   'ad_platforms' = Use self-reported conversions from Facebook/Google (typically over-report)
--   'tag'          = Use first-party clickstream tracking from clearlift-events (most accurate)
--   'connectors'   = Use revenue connectors like Stripe, Shopify, etc.

ALTER TABLE ai_optimization_settings
  ADD COLUMN conversion_source TEXT DEFAULT 'tag'
  CHECK(conversion_source IN ('ad_platforms', 'tag', 'connectors'));

-- Index for querying by conversion source
CREATE INDEX IF NOT EXISTS idx_ai_settings_conversion_source
  ON ai_optimization_settings(conversion_source);
