-- ============================================================================
-- MIGRATION: Add Funnel Transitions Table
-- ============================================================================
-- Tracks goal-to-goal and page-to-page transitions for funnel analysis
-- Used for statistical attribution when click IDs are missing
-- ============================================================================

-- ============================================================================
-- FUNNEL TRANSITIONS (goal step to step conversion rates)
-- ============================================================================
CREATE TABLE IF NOT EXISTS funnel_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,

  -- Source and destination (can be goal_id or page_path)
  from_type TEXT NOT NULL,       -- 'goal' or 'page'
  from_id TEXT NOT NULL,         -- goal_id or normalized page_path
  from_name TEXT,                -- goal name or page title

  to_type TEXT NOT NULL,         -- 'goal', 'page', or 'conversion'
  to_id TEXT NOT NULL,           -- goal_id, page_path, or 'macro_conversion'
  to_name TEXT,                  -- goal name or page title

  -- Transition metrics
  visitors_at_from INTEGER NOT NULL DEFAULT 0,     -- Unique visitors who reached from_id
  visitors_transitioned INTEGER NOT NULL DEFAULT 0, -- Unique visitors who went from_id -> to_id
  transition_rate REAL NOT NULL DEFAULT 0,          -- visitors_transitioned / visitors_at_from

  -- Conversion metrics (how many of those who transitioned eventually converted)
  conversions INTEGER NOT NULL DEFAULT 0,           -- Visitors who reached macro conversion
  conversion_rate REAL NOT NULL DEFAULT 0,          -- conversions / visitors_transitioned
  revenue_cents INTEGER NOT NULL DEFAULT 0,         -- Total revenue from these conversions

  -- Time metrics
  avg_time_to_transition_hours REAL,               -- Average time from from_id to to_id

  -- Period
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, from_type, from_id, to_type, to_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ft_org ON funnel_transitions(org_tag);
CREATE INDEX IF NOT EXISTS idx_ft_org_period ON funnel_transitions(org_tag, period_start);
CREATE INDEX IF NOT EXISTS idx_ft_org_from ON funnel_transitions(org_tag, from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_ft_org_to ON funnel_transitions(org_tag, to_type, to_id);

-- ============================================================================
-- GOAL COMPLETION METRICS (daily aggregation of goal completions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS goal_completion_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  date TEXT NOT NULL,

  -- Goal info
  goal_name TEXT,
  goal_type TEXT,                -- 'engagement', 'micro_conversion', 'macro_conversion'
  funnel_position INTEGER,       -- Position in funnel (1 = top, higher = closer to conversion)

  -- Completion metrics
  completions INTEGER NOT NULL DEFAULT 0,       -- Number of goal completions
  unique_visitors INTEGER NOT NULL DEFAULT 0,   -- Unique visitors who completed
  completion_value_cents INTEGER NOT NULL DEFAULT 0,

  -- Conversion metrics (how many went on to convert)
  downstream_conversions INTEGER NOT NULL DEFAULT 0,
  downstream_conversion_rate REAL NOT NULL DEFAULT 0,
  downstream_revenue_cents INTEGER NOT NULL DEFAULT 0,

  -- Attribution breakdowns (JSON)
  by_channel TEXT,               -- {"paid_search": 120, "organic": 80}
  by_utm_source TEXT,            -- {"google": 100, "facebook": 50}
  by_device TEXT,                -- {"desktop": 150, "mobile": 100}

  computed_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, goal_id, date)
);

CREATE INDEX IF NOT EXISTS idx_gcm_org_date ON goal_completion_metrics(org_tag, date DESC);
CREATE INDEX IF NOT EXISTS idx_gcm_org_goal ON goal_completion_metrics(org_tag, goal_id);
CREATE INDEX IF NOT EXISTS idx_gcm_org_type ON goal_completion_metrics(org_tag, goal_type);

-- ============================================================================
-- COMMENTS
-- ============================================================================
-- Funnel transitions enable:
-- 1. Computing conversion rates between funnel steps (cart -> checkout -> purchase)
-- 2. Statistical attribution: visitors at higher funnel steps get more credit
-- 3. Expected value computation: P(goal -> conversion) × conversion_value
-- 4. Identifying funnel drop-off points
--
-- Goal completion metrics provide:
-- 1. Daily goal completion counts by channel
-- 2. Downstream conversion tracking (did this goal lead to revenue?)
-- 3. Funnel position tracking for weighting
