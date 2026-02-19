-- Migration: Add unified_event_type to webhook_events
-- Normalizes connector-specific events to standard types for cross-connector reporting

-- Ensure webhook tables exist (created in 0071 on prod, but numbered as 0077 locally)
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  endpoint_secret TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  events_subscribed TEXT,
  last_received_at TEXT,
  receive_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connector)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT,
  payload_hash TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  error_message TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

-- Add unified_event_type column to webhook_events
ALTER TABLE webhook_events ADD COLUMN unified_event_type TEXT;

-- Add index for querying by unified event type
CREATE INDEX IF NOT EXISTS idx_webhook_events_unified_type
ON webhook_events(organization_id, unified_event_type);

-- Add composite index for filtering by connector and unified type
CREATE INDEX IF NOT EXISTS idx_webhook_events_connector_unified
ON webhook_events(organization_id, connector, unified_event_type);
