-- Grouped migration: funnel_transitions
-- Tables: funnel_transitions

-- Table: funnel_transitions
CREATE TABLE funnel_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_name TEXT,
  visitors_at_from INTEGER NOT NULL DEFAULT 0,
  visitors_transitioned INTEGER NOT NULL DEFAULT 0,
  transition_rate REAL NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  conversion_rate REAL NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0,
  avg_time_to_transition_hours REAL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, from_type, from_id, to_type, to_id, period_start)
);

-- Indexes for funnel_transitions
CREATE INDEX idx_ft_org ON funnel_transitions(org_tag);
CREATE INDEX idx_ft_org_from ON funnel_transitions(org_tag, from_type, from_id);
CREATE INDEX idx_ft_org_period ON funnel_transitions(org_tag, period_start);
CREATE INDEX idx_ft_org_to ON funnel_transitions(org_tag, to_type, to_id);
