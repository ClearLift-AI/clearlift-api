-- Grouped migration: unified_analytics
-- Tables: analytics_sessions, analytics_users, analytics_events

-- Table: analytics_sessions
CREATE TABLE analytics_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_ref TEXT,
  user_external_id TEXT,
  anonymous_id TEXT,
  session_number INTEGER,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_seconds INTEGER,
  page_views INTEGER DEFAULT 0,
  event_count INTEGER DEFAULT 0,
  engaged INTEGER DEFAULT 0,
  engagement_time_seconds INTEGER DEFAULT 0,
  bounce INTEGER DEFAULT 0,
  entry_page TEXT,
  exit_page TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  content TEXT,
  term TEXT,
  referrer TEXT,
  landing_page TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  screen_resolution TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for analytics_sessions
CREATE INDEX idx_analytics_sessions_date ON analytics_sessions(organization_id, start_time);
CREATE INDEX idx_analytics_sessions_org ON analytics_sessions(organization_id, source_platform);
CREATE INDEX idx_analytics_sessions_user ON analytics_sessions(organization_id, user_ref);

-- Table: analytics_users
CREATE TABLE analytics_users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  anonymous_id TEXT,
  email_hash TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  session_count INTEGER DEFAULT 0,
  event_count INTEGER DEFAULT 0,
  total_time_seconds INTEGER DEFAULT 0,
  first_source TEXT,
  first_medium TEXT,
  first_campaign TEXT,
  latest_source TEXT,
  latest_medium TEXT,
  latest_campaign TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  language TEXT,
  user_properties TEXT,
  computed_traits TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for analytics_users
CREATE INDEX idx_analytics_users_org ON analytics_users(organization_id, source_platform);

-- Table: analytics_events
CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT,
  user_ref TEXT,
  user_external_id TEXT,
  session_ref TEXT,
  session_external_id TEXT,
  anonymous_id TEXT,
  event_name TEXT NOT NULL,
  event_category TEXT,
  event_action TEXT,
  event_label TEXT,
  event_value REAL,
  page_url TEXT,
  page_title TEXT,
  page_path TEXT,
  referrer TEXT,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  event_properties TEXT,
  user_properties TEXT,
  properties TEXT,
  raw_data TEXT,
  occurred_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for analytics_events
CREATE INDEX idx_analytics_events_date ON analytics_events(organization_id, occurred_at);
CREATE INDEX idx_analytics_events_name ON analytics_events(organization_id, event_name);
CREATE INDEX idx_analytics_events_org ON analytics_events(organization_id, source_platform);
