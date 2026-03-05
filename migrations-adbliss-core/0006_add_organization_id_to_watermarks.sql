-- Add organization_id to event_sync_watermarks
-- organization_id (UUID) is the canonical org identifier per project convention

ALTER TABLE event_sync_watermarks ADD COLUMN organization_id TEXT;
CREATE INDEX idx_event_sync_watermarks_org_id ON event_sync_watermarks(organization_id);
