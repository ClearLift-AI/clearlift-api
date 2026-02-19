-- Unified Events/Webinar Tables
-- Supports: Zoom, Eventbrite, Livestorm, Hopin, Luma, Webflow Events

CREATE TABLE IF NOT EXISTS events_definitions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  event_type TEXT,                     -- 'webinar', 'meeting', 'conference', 'workshop', 'virtual', 'in_person', 'hybrid'
  status TEXT NOT NULL,                -- 'draft', 'scheduled', 'live', 'ended', 'cancelled'
  visibility TEXT DEFAULT 'public',    -- 'public', 'private', 'unlisted'
  timezone TEXT,
  start_time TEXT,
  end_time TEXT,
  duration_minutes INTEGER,
  is_recurring INTEGER DEFAULT 0,
  recurrence_pattern TEXT,             -- JSON: recurrence rules
  location_type TEXT,                  -- 'online', 'in_person', 'hybrid'
  location_name TEXT,
  location_address TEXT,
  meeting_url TEXT,
  registration_url TEXT,
  capacity INTEGER,
  registration_count INTEGER DEFAULT 0,
  attendee_count INTEGER DEFAULT 0,
  price_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  is_free INTEGER DEFAULT 1,
  host_id TEXT,
  host_name TEXT,
  tags TEXT,                           -- JSON array
  settings TEXT,                       -- JSON: platform-specific settings
  properties TEXT,                     -- JSON
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS events_registrations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_external_id TEXT NOT NULL,
  email_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  job_title TEXT,
  status TEXT NOT NULL,                -- 'registered', 'confirmed', 'cancelled', 'waitlisted'
  registration_type TEXT,              -- 'standard', 'vip', 'speaker', 'sponsor'
  ticket_type TEXT,
  ticket_price_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  payment_status TEXT,                 -- 'pending', 'paid', 'refunded', 'free'
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer TEXT,
  custom_fields TEXT,                  -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  registered_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS events_attendees (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_external_id TEXT NOT NULL,
  registration_ref TEXT,
  registration_external_id TEXT,
  email_hash TEXT,
  name TEXT,
  status TEXT NOT NULL,                -- 'joined', 'left', 'no_show'
  join_time TEXT,
  leave_time TEXT,
  duration_seconds INTEGER,
  attendance_percentage REAL,          -- % of event attended
  is_host INTEGER DEFAULT 0,
  is_panelist INTEGER DEFAULT 0,
  device_type TEXT,
  location_country TEXT,
  engagement_score REAL,               -- Platform-specific engagement metric
  questions_asked INTEGER DEFAULT 0,
  polls_answered INTEGER DEFAULT 0,
  messages_sent INTEGER DEFAULT 0,
  hand_raises INTEGER DEFAULT 0,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS events_recordings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_external_id TEXT NOT NULL,
  title TEXT,
  recording_type TEXT,                 -- 'video', 'audio', 'transcript', 'chat'
  status TEXT,                         -- 'processing', 'available', 'deleted'
  duration_seconds INTEGER,
  file_size_bytes INTEGER,
  download_url TEXT,
  play_url TEXT,
  password TEXT,
  view_count INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  recorded_at TEXT,
  available_at TEXT,
  expires_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_definitions_org ON events_definitions(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_events_definitions_date ON events_definitions(organization_id, start_time);
CREATE INDEX IF NOT EXISTS idx_events_registrations_org ON events_registrations(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_events_registrations_event ON events_registrations(organization_id, event_ref);
CREATE INDEX IF NOT EXISTS idx_events_attendees_event ON events_attendees(organization_id, event_ref);
