-- ============================================================================
-- MIGRATION 0015: Add Compound Indexes for Query Performance
-- ============================================================================
-- Adds compound indexes to improve query performance for common access patterns
-- on conversions, customer_identities, journeys, and channel_transitions tables.
-- ============================================================================

-- ============================================================================
-- CONVERSIONS TABLE INDEXES
-- Optimizes queries filtering by source, platform, and campaign with date ordering
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_conv_org_source_date
  ON conversions(organization_id, conversion_source, conversion_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_conv_org_platform_date
  ON conversions(organization_id, attributed_platform, conversion_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_conv_org_campaign_date
  ON conversions(organization_id, attributed_campaign_id, conversion_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_conv_org_source_platform_date
  ON conversions(organization_id, conversion_source, attributed_platform, conversion_timestamp DESC);

-- ============================================================================
-- CUSTOMER IDENTITIES TABLE INDEXES
-- Optimizes queries for identity resolution and confidence-based lookups
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_ci_org_confidence
  ON customer_identities(organization_id, identity_confidence DESC);

CREATE INDEX IF NOT EXISTS idx_ci_org_tag_updated
  ON customer_identities(org_tag, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ci_org_method
  ON customer_identities(organization_id, identity_method);

-- ============================================================================
-- JOURNEYS TABLE INDEXES
-- Optimizes funnel analysis and goal-based attribution queries
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_j_org_converted_value
  ON journeys(org_tag, converted, conversion_value_cents DESC);

CREATE INDEX IF NOT EXISTS idx_j_org_goal
  ON journeys(org_tag, conversion_goal_id);

CREATE INDEX IF NOT EXISTS idx_j_org_anonymous_converted
  ON journeys(org_tag, anonymous_id, converted);

-- ============================================================================
-- CHANNEL TRANSITIONS TABLE INDEXES
-- Optimizes Markov chain queries for transition matrix lookups
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_ct_org_from_channel
  ON channel_transitions(org_tag, from_channel);

CREATE INDEX IF NOT EXISTS idx_ct_org_to_channel
  ON channel_transitions(org_tag, to_channel);

CREATE INDEX IF NOT EXISTS idx_ct_org_period_from
  ON channel_transitions(org_tag, period_start, from_channel);
