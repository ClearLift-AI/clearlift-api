-- Migration 0032: Add tracking_domains table for domain-based org auto-detection
-- Enables GTM users to track events without client-side org_tag configuration
-- Server resolves page_hostname -> organization_id -> org_tag

CREATE TABLE IF NOT EXISTS tracking_domains (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    domain TEXT UNIQUE NOT NULL,  -- e.g., "rockbot.com", "www.rockbot.com"
    is_verified BOOLEAN DEFAULT FALSE,
    is_primary BOOLEAN DEFAULT FALSE,  -- Primary domain for this org
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Index for fast domain lookups (the primary use case)
CREATE INDEX IF NOT EXISTS idx_tracking_domains_domain ON tracking_domains(domain);

-- Index for listing domains by organization
CREATE INDEX IF NOT EXISTS idx_tracking_domains_org_id ON tracking_domains(organization_id);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_tracking_domains_timestamp
    AFTER UPDATE ON tracking_domains
    FOR EACH ROW
BEGIN
    UPDATE tracking_domains
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;
