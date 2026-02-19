-- ============================================================================
-- MIGRATION 0072: Add Funnel Branching Support
-- ============================================================================
-- Part of: Infrastructure Phase 4 - Funnel Branching (OR/AND)
--
-- Enables:
-- - Parallel paths (self-serve vs sales-led)
-- - Conditional branching with OR/AND logic
-- - Flow tagging for path-specific attribution
-- - Multi-parent goal relationships
-- ============================================================================

-- =============================================================================
-- 1. EXTEND GOAL_RELATIONSHIPS TABLE
-- =============================================================================

-- Relationship operator: how to combine multiple upstream goals
-- 'OR': Any upstream triggers (default, existing behavior)
-- 'AND': All upstreams must trigger
ALTER TABLE goal_relationships ADD COLUMN relationship_operator TEXT DEFAULT 'OR';

-- Flow tag: identifies which path this relationship belongs to
-- e.g., 'self_serve', 'sales_led', 'enterprise'
ALTER TABLE goal_relationships ADD COLUMN flow_tag TEXT;

-- Exclusive flag: if true, user can only be on one path at a time
ALTER TABLE goal_relationships ADD COLUMN is_exclusive INTEGER DEFAULT 0;

-- =============================================================================
-- 2. EXTEND CONVERSION_GOALS TABLE
-- =============================================================================

-- Flow tag: which flow(s) this goal belongs to
-- Can be null (global) or a specific flow
ALTER TABLE conversion_goals ADD COLUMN flow_tag TEXT;

-- Exclusive flag: if true, completing this goal removes user from other flows
ALTER TABLE conversion_goals ADD COLUMN is_exclusive INTEGER DEFAULT 0;

-- Parent goal IDs: JSON array for multi-parent support
-- e.g., '["goal-1", "goal-2"]' when this goal requires both parents
ALTER TABLE conversion_goals ADD COLUMN parent_goal_ids TEXT;

-- =============================================================================
-- 3. GOAL BRANCHES TABLE
-- =============================================================================
-- Defines split and join points in the funnel

CREATE TABLE IF NOT EXISTS goal_branches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,

  -- The goal where branching occurs
  branch_goal_id TEXT NOT NULL,

  -- Type of branch
  -- 'split': One path becomes many (after lead, user can go self-serve or sales)
  -- 'join': Many paths become one (both self-serve and sales-led reach purchase)
  branch_type TEXT NOT NULL CHECK(branch_type IN ('split', 'join')),

  -- Flow tags for the branches (JSON array)
  -- For 'split': the available paths after this point
  -- For 'join': the paths that converge at this point
  flow_tags TEXT,

  -- Optional: conditions for branch selection (JSON)
  -- e.g., {"self_serve": {"deal_value": {"lt": 10000}}}
  branch_conditions TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_branches_org
  ON goal_branches(organization_id);

CREATE INDEX IF NOT EXISTS idx_goal_branches_goal
  ON goal_branches(branch_goal_id);

-- =============================================================================
-- 4. ACQUISITION INSTANCES TABLE (UI-OVERHAUL-PLAN Phase 4)
-- =============================================================================
-- Stores individual acquisition channel instances
-- Allows multiple instances of the same connector with different filters

CREATE TABLE IF NOT EXISTS acquisition_instances (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,

  -- The connector type (google, facebook, etc.)
  connector TEXT NOT NULL,

  -- User-friendly label (e.g., "Brand Campaigns", "Performance Max")
  label TEXT NOT NULL,

  -- Filter expression to identify this subset (JSON)
  -- e.g., {"campaign_name": {"contains": "Brand"}}
  filter TEXT,

  -- Display position
  display_order INTEGER DEFAULT 0,

  -- Active flag
  is_active INTEGER DEFAULT 1,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_acquisition_instances_org
  ON acquisition_instances(organization_id);

-- =============================================================================
-- 5. CONVERSION CONFIGS TABLE (UI-OVERHAUL-PLAN Phase 4)
-- =============================================================================
-- Stores conversion event configurations
-- Maps connector events to conversion goals

CREATE TABLE IF NOT EXISTS conversion_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,

  -- The connector source (stripe, shopify, tag, etc.)
  connector TEXT NOT NULL,

  -- The event type to track
  event TEXT NOT NULL,

  -- Filters for this conversion (JSON)
  -- e.g., {"amount": {"gt": 0}, "status": {"equals": "succeeded"}}
  filters TEXT,

  -- User-friendly label
  label TEXT NOT NULL,

  -- Associated goal (optional)
  goal_id TEXT,

  -- Value configuration
  value_type TEXT DEFAULT 'from_source',  -- 'from_source', 'fixed', 'calculated'
  fixed_value_cents INTEGER,

  -- Display position
  display_order INTEGER DEFAULT 0,

  -- Active flag
  is_active INTEGER DEFAULT 1,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES conversion_goals(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_conversion_configs_org
  ON conversion_configs(organization_id);

CREATE INDEX IF NOT EXISTS idx_conversion_configs_goal
  ON conversion_configs(goal_id)
  WHERE goal_id IS NOT NULL;

-- =============================================================================
-- 6. INDEXES FOR NEW COLUMNS
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_goal_relationships_flow_tag
  ON goal_relationships(organization_id, flow_tag)
  WHERE flow_tag IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversion_goals_flow_tag
  ON conversion_goals(organization_id, flow_tag)
  WHERE flow_tag IS NOT NULL;
