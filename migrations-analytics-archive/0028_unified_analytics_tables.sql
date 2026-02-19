-- Unified Analytics/CDP Tables
-- Supports: GA4, Mixpanel, Amplitude, Segment, Heap, Rudderstack, mParticle

CREATE TABLE IF NOT EXISTS analytics_users (
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
  user_properties TEXT,                -- JSON: custom properties
  computed_traits TEXT,                -- JSON: computed traits from CDP
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS analytics_sessions (
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
  engaged INTEGER DEFAULT 0,           -- Boolean: was engaged
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
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS analytics_events (
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
  event_properties TEXT,               -- JSON: event-specific properties
  user_properties TEXT,                -- JSON: user properties at event time
  properties TEXT,                     -- JSON
  raw_data TEXT,
  occurred_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics_page_views (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT,
  user_ref TEXT,
  user_external_id TEXT,
  session_ref TEXT,
  session_external_id TEXT,
  anonymous_id TEXT,
  page_url TEXT NOT NULL,
  page_path TEXT,
  page_title TEXT,
  page_referrer TEXT,
  time_on_page_seconds INTEGER,
  scroll_depth_percent REAL,
  source TEXT,
  medium TEXT,
  campaign TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  viewed_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_analytics_users_org ON analytics_users(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_org ON analytics_sessions(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_user ON analytics_sessions(organization_id, user_ref);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_date ON analytics_sessions(organization_id, start_time);
CREATE INDEX IF NOT EXISTS idx_analytics_events_org ON analytics_events(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events(organization_id, event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_date ON analytics_events(organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_page_views_org ON analytics_page_views(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_analytics_page_views_date ON analytics_page_views(organization_id, viewed_at);
