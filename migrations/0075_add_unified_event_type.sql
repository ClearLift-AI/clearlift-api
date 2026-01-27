-- Migration: Add unified_event_type to webhook_events
-- Normalizes connector-specific events to standard types for cross-connector reporting

-- Add unified_event_type column to webhook_events
ALTER TABLE webhook_events ADD COLUMN unified_event_type TEXT;

-- Add index for querying by unified event type
CREATE INDEX IF NOT EXISTS idx_webhook_events_unified_type
ON webhook_events(organization_id, unified_event_type);

-- Add composite index for filtering by connector and unified type
CREATE INDEX IF NOT EXISTS idx_webhook_events_connector_unified
ON webhook_events(organization_id, connector, unified_event_type);
