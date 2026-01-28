-- Migration: 0071_add_webhook_endpoints.sql
-- Description: Add tables for webhook endpoint management and event tracking
-- Part of: Infrastructure Phase 2 - Webhook Ingestion
--
-- This migration creates the infrastructure for receiving real-time webhooks
-- from platforms like Stripe, Shopify, and HubSpot.

-- =============================================================================
-- WEBHOOK ENDPOINTS TABLE
-- =============================================================================
-- Stores registered webhook endpoints for each organization/connector pair.
-- Each organization can have one endpoint per connector platform.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  -- Secret for verifying webhook signatures (platform-specific)
  endpoint_secret TEXT NOT NULL,
  -- Whether the endpoint is active
  is_active INTEGER DEFAULT 1,
  -- JSON array of event types subscribed to (null = all events)
  events_subscribed TEXT,
  -- Tracking metadata
  last_received_at TEXT,
  receive_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  -- One endpoint per org/connector combination
  UNIQUE(organization_id, connector)
);

-- Index for looking up endpoints by org
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org
  ON webhook_endpoints(organization_id);

-- Index for looking up endpoints by connector
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_connector
  ON webhook_endpoints(connector) WHERE is_active = 1;

-- =============================================================================
-- WEBHOOK EVENTS TABLE
-- =============================================================================
-- Stores incoming webhook events for processing and deduplication.
-- Events are queued for async processing by the queue consumer.

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  -- Event type (platform-specific, e.g., 'payment_intent.succeeded')
  event_type TEXT NOT NULL,
  -- Platform's event ID for deduplication (null if not provided)
  event_id TEXT,
  -- SHA-256 hash of payload for duplicate detection
  payload_hash TEXT,
  -- Full event payload (JSON)
  payload TEXT,
  -- Processing status
  status TEXT DEFAULT 'pending',  -- pending, processing, completed, failed, skipped
  attempts INTEGER DEFAULT 0,
  error_message TEXT,
  -- Timestamps
  received_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT,

  -- Foreign key to endpoint
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

-- Index for processing queue (status + received time)
CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON webhook_events(status, received_at);

-- Index for deduplication (org + connector + platform event ID)
CREATE INDEX IF NOT EXISTS idx_webhook_events_dedup
  ON webhook_events(organization_id, connector, event_id)
  WHERE event_id IS NOT NULL;

-- Index for finding events by payload hash (backup dedup)
CREATE INDEX IF NOT EXISTS idx_webhook_events_hash
  ON webhook_events(organization_id, connector, payload_hash)
  WHERE payload_hash IS NOT NULL;

-- Index for endpoint lookup
CREATE INDEX IF NOT EXISTS idx_webhook_events_endpoint
  ON webhook_events(endpoint_id);

-- =============================================================================
-- WEBHOOK DELIVERY LOG TABLE
-- =============================================================================
-- Tracks individual delivery attempts for debugging and monitoring.

CREATE TABLE IF NOT EXISTS webhook_delivery_log (
  id TEXT PRIMARY KEY,
  webhook_event_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,  -- success, failed
  status_code INTEGER,
  response_body TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (webhook_event_id) REFERENCES webhook_events(id) ON DELETE CASCADE
);

-- Index for finding logs by event
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_log_event
  ON webhook_delivery_log(webhook_event_id);
