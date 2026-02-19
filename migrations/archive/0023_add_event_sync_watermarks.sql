-- Add event_sync_watermarks table for incremental event syncing
-- Tracks the last synced timestamp per organization (by org_tag)
-- Used by clearlift-cron EventsConnector to avoid reprocessing events

CREATE TABLE IF NOT EXISTS event_sync_watermarks (
    org_tag TEXT PRIMARY KEY, -- Organization short tag (e.g., 'customer_123')

    -- Sync state
    last_synced_timestamp TEXT NOT NULL, -- ISO 8601 timestamp of last successfully synced event
    last_synced_event_id TEXT, -- Optional: last event_id for idempotency
    records_synced INTEGER DEFAULT 0, -- Number of records synced in last run

    -- Status tracking
    last_sync_status TEXT NOT NULL CHECK(last_sync_status IN ('success', 'partial', 'failed')),
    last_sync_error TEXT, -- Error message if sync failed

    -- Metadata
    updated_at TEXT DEFAULT (datetime('now')) -- ISO 8601 timestamp

    -- No foreign key to organizations since org_tag is not guaranteed to map to organization_id 1:1
    -- The tag mapping is stored in tag_mapping table
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_event_sync_watermarks_status
    ON event_sync_watermarks(last_sync_status);

CREATE INDEX IF NOT EXISTS idx_event_sync_watermarks_timestamp
    ON event_sync_watermarks(last_synced_timestamp);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_event_sync_watermarks_timestamp
    AFTER UPDATE ON event_sync_watermarks
    FOR EACH ROW
BEGIN
    UPDATE event_sync_watermarks
    SET updated_at = datetime('now')
    WHERE org_tag = NEW.org_tag;
END;
