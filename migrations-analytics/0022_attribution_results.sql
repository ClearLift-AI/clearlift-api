-- Grouped migration: attribution_results
-- Tables: attribution_results, channel_transitions

-- Table: attribution_results
CREATE TABLE attribution_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  model TEXT NOT NULL,
  channel TEXT NOT NULL,
  credit REAL NOT NULL,
  conversions REAL NOT NULL,
  revenue_cents INTEGER NOT NULL,
  removal_effect REAL,
  shapley_value REAL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, model, channel, period_start)
);

-- Indexes for attribution_results
CREATE INDEX idx_ar_org_model ON attribution_results(org_tag, model);
CREATE INDEX idx_ar_org_period ON attribution_results(org_tag, period_start);

-- Table: channel_transitions
CREATE TABLE channel_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_tag TEXT NOT NULL,
  from_channel TEXT NOT NULL,
  to_channel TEXT NOT NULL,
  transition_count INTEGER NOT NULL DEFAULT 0,
  converting_count INTEGER NOT NULL DEFAULT 0,
  probability REAL NOT NULL DEFAULT 0,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_tag, from_channel, to_channel, period_start)
);

-- Indexes for channel_transitions
CREATE INDEX idx_ct_org ON channel_transitions(org_tag);
CREATE INDEX idx_ct_org_from_channel ON channel_transitions(org_tag, from_channel);
CREATE INDEX idx_ct_org_period ON channel_transitions(org_tag, period_start);
CREATE INDEX idx_ct_org_period_from ON channel_transitions(org_tag, period_start, from_channel);
CREATE INDEX idx_ct_org_to_channel ON channel_transitions(org_tag, to_channel);
