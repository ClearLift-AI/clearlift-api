-- ============================================================================
-- MIGRATION 0035: Multi-Conversion Support for Analytics DB
-- ============================================================================
-- Extends the conversions table to support multi-goal attribution
-- Companion to main DB migration 0073_add_multi_conversion.sql
-- ============================================================================

-- =============================================================================
-- 1. EXTEND CONVERSIONS TABLE FOR MULTI-GOAL SUPPORT
-- =============================================================================

-- Goal IDs this conversion is attributed to (JSON array)
-- Previously conversions mapped to a single goal; now can map to multiple
ALTER TABLE conversions ADD COLUMN goal_ids TEXT;

-- Value allocated to each goal (JSON object: {goal_id: value_cents})
-- For multi-goal conversions, tracks how value is split
ALTER TABLE conversions ADD COLUMN goal_values TEXT;

-- Attribution group this conversion belongs to
ALTER TABLE conversions ADD COLUMN attribution_group_id TEXT;

-- =============================================================================
-- 2. VALUE ALLOCATIONS TABLE
-- =============================================================================
-- Tracks how conversion value is allocated across goals
-- Useful for reporting and debugging

CREATE TABLE IF NOT EXISTS conversion_value_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  conversion_id TEXT NOT NULL,

  -- Goal that received value
  goal_id TEXT NOT NULL,

  -- Allocated value
  allocated_value_cents INTEGER NOT NULL,

  -- Allocation method
  -- 'equal': Split evenly across matched goals
  -- 'weighted': Used weights from goal_group_members
  -- 'explicit': Used goal's fixed_value_cents
  -- 'proportional': Based on touchpoint proximity
  allocation_method TEXT NOT NULL,

  -- Weight used (if weighted allocation)
  weight_used REAL,

  -- Touchpoints that contributed to this goal
  touchpoint_count INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (conversion_id) REFERENCES conversions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cva_conversion
  ON conversion_value_allocations(conversion_id);

CREATE INDEX IF NOT EXISTS idx_cva_goal
  ON conversion_value_allocations(goal_id);

CREATE INDEX IF NOT EXISTS idx_cva_org_created
  ON conversion_value_allocations(organization_id, created_at);

-- =============================================================================
-- 3. INDEXES FOR NEW COLUMNS
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_conversions_attribution_group
  ON conversions(organization_id, attribution_group_id)
  WHERE attribution_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversions_goal_ids
  ON conversions(organization_id)
  WHERE goal_ids IS NOT NULL;
