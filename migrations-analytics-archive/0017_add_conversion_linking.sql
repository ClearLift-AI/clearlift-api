-- ============================================================================
-- MIGRATION 0017: Add Conversion Linking Columns
-- ============================================================================
-- Adds columns to link Stripe/Shopify conversions to tag-based conversion goals.
-- This enables deterministic attribution when a purchase can be matched to a
-- specific goal_id from tag events.
--
-- Linking methods:
-- 1. 'direct_link' - Stripe metadata contains pi_anonymous_id or session_id
-- 2. 'email_hash' - customer_email_hash matches tag event with goal_id
-- 3. 'time_proximity' - Events within 48h of purchase, scored by engagement
-- ============================================================================

-- Add linking columns to conversions table
ALTER TABLE conversions ADD COLUMN linked_goal_id TEXT;
ALTER TABLE conversions ADD COLUMN link_confidence REAL DEFAULT 1.0;
ALTER TABLE conversions ADD COLUMN link_method TEXT;
ALTER TABLE conversions ADD COLUMN linked_at TEXT;

-- Index for finding unlinked conversions efficiently
-- Partial index on NULL values for batch processing
CREATE INDEX IF NOT EXISTS idx_conversions_unlinked
  ON conversions(organization_id, conversion_source, conversion_timestamp)
  WHERE linked_goal_id IS NULL;

-- Index for querying by link method (for analytics)
CREATE INDEX IF NOT EXISTS idx_conversions_link_method
  ON conversions(organization_id, link_method)
  WHERE link_method IS NOT NULL;

-- Index for querying linked conversions by goal
CREATE INDEX IF NOT EXISTS idx_conversions_linked_goal
  ON conversions(organization_id, linked_goal_id)
  WHERE linked_goal_id IS NOT NULL;
