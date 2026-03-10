-- D1 Sink: adbliss_events table for row-level event queries
-- Replaces R2 SQL queries in cron workflows
-- See: clearlift-events/docs/plans/2026-03-10-d1-sink-migration-design.md

CREATE TABLE IF NOT EXISTS adbliss_events (
  -- Core (5)
  event_id              TEXT NOT NULL,
  org_tag               TEXT NOT NULL,
  event_type            TEXT,
  timestamp             TEXT NOT NULL,
  ingested_at           TEXT NOT NULL DEFAULT (datetime('now')),

  -- Identity (5)
  anonymous_id          TEXT NOT NULL,
  session_id            TEXT,
  user_id               TEXT,
  user_id_hash          TEXT,
  device_fingerprint_id TEXT,

  -- Page Context (4)
  page_url              TEXT,
  page_path             TEXT,
  referrer              TEXT,
  referrer_domain       TEXT,

  -- UTM Attribution (5)
  utm_source            TEXT,
  utm_medium            TEXT,
  utm_campaign          TEXT,
  utm_term              TEXT,
  utm_content           TEXT,

  -- Platform Click IDs (5)
  gclid                 TEXT,
  fbclid                TEXT,
  ttclid                TEXT,
  msclkid               TEXT,
  li_fat_id             TEXT,

  -- Goals (2)
  goal_id               TEXT,
  goal_value            REAL,

  -- Device/Geo (5)
  device_type           TEXT,
  browser_name          TEXT,
  os_name               TEXT,
  geo_country           TEXT,
  geo_region            TEXT,

  -- Navigation / Session Stitching (4)
  click_destination_hostname TEXT,
  click_destination_path     TEXT,
  navigation_id              TEXT,
  navigation_source_path     TEXT,

  PRIMARY KEY (org_tag, event_id)
);

-- Query patterns from cron workflows
CREATE INDEX IF NOT EXISTS idx_adbliss_events_org_ts
  ON adbliss_events (org_tag, timestamp);

CREATE INDEX IF NOT EXISTS idx_adbliss_events_org_anon
  ON adbliss_events (org_tag, anonymous_id);

CREATE INDEX IF NOT EXISTS idx_adbliss_events_org_hash
  ON adbliss_events (org_tag, user_id_hash)
  WHERE user_id_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_adbliss_events_org_goal
  ON adbliss_events (org_tag, goal_id)
  WHERE goal_id IS NOT NULL;
