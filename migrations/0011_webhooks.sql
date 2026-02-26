-- Grouped migration: webhooks
-- Tables: webhook_endpoints, webhook_events, webhook_delivery_log

-- Table: webhook_endpoints
CREATE TABLE webhook_endpoints (
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

-- Indexes for webhook_endpoints
CREATE INDEX idx_webhook_endpoints_connector ON webhook_endpoints(connector) WHERE is_active = 1;
CREATE INDEX idx_webhook_endpoints_org ON webhook_endpoints(organization_id);

-- Table: webhook_events
CREATE TABLE webhook_events (
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
  unified_event_type TEXT,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

-- Indexes for webhook_events
CREATE INDEX idx_webhook_events_connector_unified ON webhook_events(organization_id, connector, unified_event_type);
CREATE INDEX idx_webhook_events_dedup ON webhook_events(organization_id, connector, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_webhook_events_endpoint ON webhook_events(endpoint_id);
CREATE INDEX idx_webhook_events_hash ON webhook_events(organization_id, connector, payload_hash) WHERE payload_hash IS NOT NULL;
CREATE INDEX idx_webhook_events_status ON webhook_events(status, received_at);
CREATE INDEX idx_webhook_events_unified_type ON webhook_events(organization_id, unified_event_type);

-- Table: webhook_delivery_log
CREATE TABLE webhook_delivery_log (
  id TEXT PRIMARY KEY,
  webhook_event_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (webhook_event_id) REFERENCES webhook_events(id) ON DELETE CASCADE
);

-- Indexes for webhook_delivery_log
CREATE INDEX idx_webhook_delivery_log_event ON webhook_delivery_log(webhook_event_id);
