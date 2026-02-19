-- Migration: Add conversion goals and event filters tables
-- These tables allow users to configure what constitutes a conversion
-- and filter which events are included in attribution paths

-- Conversion Goals: Define what events count as conversions
CREATE TABLE IF NOT EXISTS conversion_goals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT CHECK(type IN ('conversion', 'micro_conversion', 'engagement')) DEFAULT 'conversion',

  -- Trigger configuration (JSON object)
  -- Can match on: event_type, page_pattern, revenue_min, custom_event
  trigger_config TEXT NOT NULL DEFAULT '{}',

  -- Default conversion value in cents (if not specified in event)
  default_value_cents INTEGER DEFAULT 0,

  -- Is this the primary conversion goal for attribution?
  is_primary BOOLEAN DEFAULT FALSE,

  -- Should events matching this goal be included as touchpoints?
  include_in_path BOOLEAN DEFAULT TRUE,

  -- Priority for matching (lower = higher priority)
  priority INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Event Filters: Include/exclude rules for attribution paths
CREATE TABLE IF NOT EXISTS event_filters (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,

  -- 'include' = only matching events used, 'exclude' = matching events removed
  filter_type TEXT CHECK(filter_type IN ('include', 'exclude')) DEFAULT 'exclude',

  -- Filter rules (JSON array of rule objects)
  -- Each rule: { field, operator, value }
  rules TEXT NOT NULL DEFAULT '[]',

  -- Is this filter currently active?
  is_active BOOLEAN DEFAULT TRUE,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_conversion_goals_org ON conversion_goals(organization_id);
CREATE INDEX IF NOT EXISTS idx_conversion_goals_primary ON conversion_goals(organization_id, is_primary);
CREATE INDEX IF NOT EXISTS idx_event_filters_org ON event_filters(organization_id);
CREATE INDEX IF NOT EXISTS idx_event_filters_active ON event_filters(organization_id, is_active);

-- Trigger to ensure only one primary goal per org
CREATE TRIGGER IF NOT EXISTS ensure_single_primary_goal
AFTER UPDATE ON conversion_goals
WHEN NEW.is_primary = TRUE
BEGIN
  UPDATE conversion_goals
  SET is_primary = FALSE, updated_at = datetime('now')
  WHERE organization_id = NEW.organization_id
    AND id != NEW.id
    AND is_primary = TRUE;
END;

-- Same trigger for insert
CREATE TRIGGER IF NOT EXISTS ensure_single_primary_goal_insert
AFTER INSERT ON conversion_goals
WHEN NEW.is_primary = TRUE
BEGIN
  UPDATE conversion_goals
  SET is_primary = FALSE, updated_at = datetime('now')
  WHERE organization_id = NEW.organization_id
    AND id != NEW.id
    AND is_primary = TRUE;
END;
