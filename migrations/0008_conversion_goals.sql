-- Grouped migration: conversion_goals
-- Tables: conversion_goals, goal_relationships, goal_branches, goal_groups, goal_group_members, goal_templates, goal_value_history, goal_conversion_stats

-- Table: conversion_goals
CREATE TABLE conversion_goals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT CHECK(type IN ('conversion', 'micro_conversion', 'engagement')) DEFAULT 'conversion',
  trigger_config TEXT NOT NULL DEFAULT '{}',
  default_value_cents INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT FALSE,
  include_in_path BOOLEAN DEFAULT TRUE,
  priority INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  slug TEXT,
  description TEXT,
  goal_type TEXT DEFAULT 'tag_event',
  revenue_sources TEXT,
  filter_config TEXT,
  value_type TEXT DEFAULT 'from_source',
  fixed_value_cents INTEGER,
  display_order INTEGER DEFAULT 0,
  color TEXT,
  icon TEXT,
  is_active INTEGER DEFAULT 1,
  avg_deal_value_cents INTEGER,
  close_rate_percent INTEGER CHECK(close_rate_percent >= 0 AND close_rate_percent <= 100),
  category TEXT DEFAULT 'micro_conversion',
  value_method TEXT DEFAULT 'explicit',
  auto_compute_value INTEGER DEFAULT 0,
  computed_value_cents INTEGER,
  computed_value_lower_cents INTEGER,
  computed_value_upper_cents INTEGER,
  value_computed_at TEXT,
  connector TEXT,
  is_conversion INTEGER DEFAULT 0,
  position_col INTEGER DEFAULT 0,
  position_row INTEGER,
  connector_event_type TEXT,
  flow_tag TEXT,
  is_exclusive INTEGER DEFAULT 0,
  parent_goal_ids TEXT,
  source_table TEXT DEFAULT NULL,
  source_conditions TEXT DEFAULT NULL,
  source_dedup_expression TEXT DEFAULT NULL,
  step_requirement TEXT DEFAULT 'auto' CHECK(step_requirement IN ('required', 'optional', 'auto')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for conversion_goals
CREATE INDEX idx_conversion_goals_flow_tag ON conversion_goals(organization_id, flow_tag) WHERE flow_tag IS NOT NULL;
CREATE INDEX idx_conversion_goals_goal_type ON conversion_goals(organization_id, goal_type);
CREATE INDEX idx_conversion_goals_org ON conversion_goals(organization_id);
CREATE INDEX idx_conversion_goals_primary ON conversion_goals(organization_id, is_primary);
CREATE UNIQUE INDEX idx_conversion_goals_slug ON conversion_goals(organization_id, slug) WHERE slug IS NOT NULL;

-- Triggers for conversion_goals
CREATE TRIGGER ensure_single_primary_goal
AFTER UPDATE ON conversion_goals
WHEN NEW.is_primary = TRUE
BEGIN
  UPDATE conversion_goals
  SET is_primary = FALSE, updated_at = datetime('now')
  WHERE organization_id = NEW.organization_id
    AND id != NEW.id
    AND is_primary = TRUE;
END;
CREATE TRIGGER ensure_single_primary_goal_insert
AFTER INSERT ON conversion_goals
WHEN NEW.is_primary = TRUE
BEGIN
  UPDATE conversion_goals
  SET is_primary = FALSE, updated_at = datetime('now')
  WHERE organization_id = NEW.organization_id
    AND id != NEW.id
    AND is_primary = TRUE;
END;

-- Table: goal_relationships
CREATE TABLE goal_relationships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  upstream_goal_id TEXT NOT NULL,
  downstream_goal_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL CHECK(relationship_type IN ('funnel', 'correlated')),
  funnel_position INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  relationship_operator TEXT DEFAULT 'OR',
  flow_tag TEXT,
  is_exclusive INTEGER DEFAULT 0,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (downstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  UNIQUE(organization_id, upstream_goal_id, downstream_goal_id)
);

-- Indexes for goal_relationships
CREATE INDEX idx_goal_relationships_downstream ON goal_relationships(organization_id, downstream_goal_id);
CREATE INDEX idx_goal_relationships_flow_tag ON goal_relationships(organization_id, flow_tag) WHERE flow_tag IS NOT NULL;
CREATE INDEX idx_goal_relationships_org ON goal_relationships(organization_id);

-- Table: goal_branches
CREATE TABLE goal_branches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  branch_goal_id TEXT NOT NULL,
  branch_type TEXT NOT NULL CHECK(branch_type IN ('split', 'join')),
  flow_tags TEXT,
  branch_conditions TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (branch_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE
);

-- Indexes for goal_branches
CREATE INDEX idx_goal_branches_goal ON goal_branches(branch_goal_id);
CREATE INDEX idx_goal_branches_org ON goal_branches(organization_id);

-- Table: goal_groups
CREATE TABLE goal_groups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  group_type TEXT DEFAULT 'conversion',
  is_default_attribution INTEGER DEFAULT 0,
  total_weight REAL DEFAULT 1.0,
  color TEXT,
  icon TEXT,
  display_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for goal_groups
CREATE INDEX idx_goal_groups_default ON goal_groups(organization_id, is_default_attribution) WHERE is_default_attribution = 1;
CREATE INDEX idx_goal_groups_org ON goal_groups(organization_id);

-- Table: goal_group_members
CREATE TABLE goal_group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  display_order INTEGER DEFAULT 0,
  inclusion_rules TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(group_id, goal_id),
  FOREIGN KEY (group_id) REFERENCES goal_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE
);

-- Indexes for goal_group_members
CREATE INDEX idx_goal_group_members_goal ON goal_group_members(goal_id);
CREATE INDEX idx_goal_group_members_group ON goal_group_members(group_id);

-- Table: goal_templates
CREATE TABLE goal_templates (
  id TEXT PRIMARY KEY,
  business_type TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  trigger_config TEXT,
  default_value_cents INTEGER,
  value_method TEXT DEFAULT 'explicit',
  suggested_funnel_position INTEGER,
  icon TEXT,
  color TEXT,
  display_order INTEGER DEFAULT 0,
  is_recommended INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for goal_templates
CREATE INDEX idx_goal_templates_business_type ON goal_templates(business_type, display_order);

-- Table: goal_value_history
CREATE TABLE goal_value_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  value_method TEXT NOT NULL,
  computed_value_cents INTEGER NOT NULL,
  confidence_lower_cents INTEGER,
  confidence_upper_cents INTEGER,
  sample_size INTEGER,
  computation_details TEXT,
  computed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE
);

-- Indexes for goal_value_history
CREATE INDEX idx_goal_value_history_lookup ON goal_value_history(organization_id, goal_id, computed_at DESC);

-- Table: goal_conversion_stats
CREATE TABLE goal_conversion_stats (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  upstream_goal_id TEXT NOT NULL,
  downstream_goal_id TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'weekly', 'monthly', 'all_time')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  upstream_count INTEGER DEFAULT 0,
  downstream_count INTEGER DEFAULT 0,
  converted_count INTEGER DEFAULT 0,
  conversion_rate REAL,
  avg_time_to_convert_hours REAL,
  median_time_to_convert_hours REAL,
  prior_alpha REAL DEFAULT 1.0,
  prior_beta REAL DEFAULT 1.0,
  computed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (downstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  UNIQUE(organization_id, upstream_goal_id, downstream_goal_id, period_type, period_start)
);

-- Indexes for goal_conversion_stats
CREATE INDEX idx_goal_conversion_stats_lookup ON goal_conversion_stats(organization_id, upstream_goal_id, downstream_goal_id, period_type);
