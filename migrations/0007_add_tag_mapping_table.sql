-- Migration number: 0007 2025-09-11T12:30:00.000Z

CREATE TABLE IF NOT EXISTS org_tag_mappings (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    short_tag TEXT UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_org_tag_mappings_organization_id ON org_tag_mappings(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_tag_mappings_short_tag ON org_tag_mappings(short_tag);
CREATE INDEX IF NOT EXISTS idx_org_tag_mappings_active ON org_tag_mappings(is_active);