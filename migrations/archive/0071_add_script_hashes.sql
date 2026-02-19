-- Migration 0071: Add script_hashes table for hash-based script URLs
-- Enables a cleaner installation flow where the script URL itself identifies the organization
-- Example: cdn.clearlift.ai/a1b2c3d4.js -> org_tag "acme"

CREATE TABLE IF NOT EXISTS script_hashes (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL UNIQUE,  -- One hash per org
    hash TEXT UNIQUE NOT NULL,              -- 8-char alphanumeric hash
    org_tag TEXT NOT NULL,                  -- Cached org_tag for fast lookup
    version TEXT DEFAULT '3.0.0',           -- Script version
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Index for fast hash lookups (the primary use case - lookup by URL path)
CREATE INDEX IF NOT EXISTS idx_script_hashes_hash ON script_hashes(hash);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_script_hashes_timestamp
    AFTER UPDATE ON script_hashes
    FOR EACH ROW
BEGIN
    UPDATE script_hashes
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

-- Auto-generate hashes for existing organizations with tag mappings
INSERT OR IGNORE INTO script_hashes (id, organization_id, hash, org_tag)
SELECT
    'sh_' || lower(hex(randomblob(8))),
    otm.organization_id,
    lower(substr(hex(randomblob(4)), 1, 8)),  -- 8-char random hex
    otm.short_tag
FROM org_tag_mappings otm
WHERE otm.is_active = TRUE
  AND otm.organization_id NOT IN (SELECT organization_id FROM script_hashes);
