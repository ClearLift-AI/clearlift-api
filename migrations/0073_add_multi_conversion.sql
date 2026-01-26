-- ============================================================================
-- MIGRATION 0073: Add Multi-Conversion Support
-- ============================================================================
-- Part of: Infrastructure Phase 5 - Multi-Conversion
--
-- Enables:
-- - Multiple conversion points per funnel
-- - Goal groups for logical grouping
-- - Value allocation across multiple goals
-- - Attribution by goal group
--
-- NOTE: The conversions table extensions are in ANALYTICS_DB migration 0035
-- ============================================================================

-- =============================================================================
-- 1. GOAL GROUPS TABLE
-- =============================================================================
-- Logical groupings of goals for attribution and reporting
-- e.g., "All Revenue Events", "Primary Conversions", "Micro Conversions"

CREATE TABLE IF NOT EXISTS goal_groups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,

  -- Group info
  name TEXT NOT NULL,
  description TEXT,

  -- Group type
  -- 'conversion': Revenue/conversion goals (purchases, signups)
  -- 'engagement': Engagement goals (content views, newsletter)
  -- 'funnel': Funnel stage goals (checkout, add to cart)
  -- 'custom': User-defined grouping
  group_type TEXT DEFAULT 'conversion',

  -- Attribution settings
  -- If true, this group is used as the default for attribution reports
  is_default_attribution INTEGER DEFAULT 0,

  -- Total weight for the group (members' weights should sum to this)
  total_weight REAL DEFAULT 1.0,

  -- Display settings
  color TEXT,
  icon TEXT,
  display_order INTEGER DEFAULT 0,

  -- Active flag
  is_active INTEGER DEFAULT 1,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_groups_org
  ON goal_groups(organization_id);

CREATE INDEX IF NOT EXISTS idx_goal_groups_default
  ON goal_groups(organization_id, is_default_attribution)
  WHERE is_default_attribution = 1;

-- =============================================================================
-- 2. GOAL GROUP MEMBERS TABLE
-- =============================================================================
-- Maps goals to groups with optional weight for value allocation

CREATE TABLE IF NOT EXISTS goal_group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,

  -- Weight for value allocation within the group
  -- e.g., if group has 3 goals with weights 0.5, 0.3, 0.2
  -- a $100 conversion touching all 3 would allocate $50, $30, $20
  weight REAL DEFAULT 1.0,

  -- Display order within the group
  display_order INTEGER DEFAULT 0,

  -- Inclusion rules (JSON)
  -- Optional filters for when this goal counts in the group
  inclusion_rules TEXT,

  created_at TEXT DEFAULT (datetime('now')),

  -- Each goal can only be in a group once
  UNIQUE(group_id, goal_id),

  FOREIGN KEY (group_id) REFERENCES goal_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_group_members_goal
  ON goal_group_members(goal_id);

CREATE INDEX IF NOT EXISTS idx_goal_group_members_group
  ON goal_group_members(group_id);
