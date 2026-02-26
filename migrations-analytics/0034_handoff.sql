-- Grouped migration: handoff
-- Tables: handoff_observations, handoff_patterns

-- Table: handoff_observations
CREATE TABLE handoff_observations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  click_event_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  session_id TEXT,
  device_fingerprint_id TEXT,
  click_destination_hostname TEXT NOT NULL,
  click_destination_path TEXT,
  navigation_source_path TEXT,
  click_timestamp TEXT NOT NULL,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  geo_country TEXT,
  matched_conversion_id TEXT,
  conversion_timestamp TEXT,
  time_to_conversion_seconds REAL,
  match_confidence REAL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(click_event_id)
);

-- Indexes for handoff_observations
CREATE INDEX idx_ho_anon_id ON handoff_observations(anonymous_id, click_timestamp DESC);
CREATE INDEX idx_ho_org_hostname ON handoff_observations(organization_id, click_destination_hostname, click_timestamp DESC);

-- Table: handoff_patterns
CREATE TABLE handoff_patterns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  click_destination_hostname TEXT NOT NULL,
  conversion_source TEXT NOT NULL,
  observation_count INTEGER DEFAULT 0,
  match_count INTEGER DEFAULT 0,
  match_rate REAL DEFAULT 0.0,
  avg_handoff_to_conversion_seconds REAL,
  p50_seconds REAL,
  p95_seconds REAL,
  min_seconds REAL,
  max_seconds REAL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_known_provider INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, click_destination_hostname, conversion_source)
);

-- Indexes for handoff_patterns
CREATE INDEX idx_hp_org_source ON handoff_patterns(organization_id, conversion_source);
