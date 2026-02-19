-- Add org_tracking_configs table for tracking tag configuration
-- Stores per-organization goals, tracking settings, and snippet configurations
-- Used by clearlift-events tag to fetch server-side config

CREATE TABLE IF NOT EXISTS org_tracking_configs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL UNIQUE,

    -- Goal tracking configuration (JSON)
    -- Format: { "goal_id": { "trigger": "pageview|click|event", "match": "/path|.selector", "value": 100 } }
    goals TEXT DEFAULT '{}',

    -- Tracking feature toggles
    enable_fingerprinting BOOLEAN DEFAULT TRUE,
    enable_cross_domain_tracking BOOLEAN DEFAULT TRUE,
    enable_performance_tracking BOOLEAN DEFAULT TRUE,

    -- Advanced settings
    session_timeout INTEGER DEFAULT 1800000, -- 30 minutes in milliseconds
    batch_size INTEGER DEFAULT 10,
    batch_timeout INTEGER DEFAULT 5000, -- 5 seconds in milliseconds

    -- Snippet configuration
    snippet_complexity TEXT DEFAULT 'simple' CHECK(snippet_complexity IN ('simple', 'advanced', 'custom')),
    custom_snippet TEXT, -- For advanced users who want full control

    -- Metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT, -- user_id who created this config

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_org_tracking_configs_org_id
    ON org_tracking_configs(organization_id);

CREATE INDEX IF NOT EXISTS idx_org_tracking_configs_snippet_complexity
    ON org_tracking_configs(snippet_complexity);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_org_tracking_configs_timestamp
    AFTER UPDATE ON org_tracking_configs
    FOR EACH ROW
BEGIN
    UPDATE org_tracking_configs
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;
