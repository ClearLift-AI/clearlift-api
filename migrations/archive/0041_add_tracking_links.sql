-- Migration 0041: Add tracking_links table for email link tracking
-- Enables users to create tracked links for email campaigns
-- Links are looked up by events worker at /r/{id} for redirect + analytics

CREATE TABLE IF NOT EXISTS tracking_links (
    id TEXT PRIMARY KEY,  -- Short unique ID used in URLs (e.g., "abc123def456")
    org_tag TEXT NOT NULL,  -- Organization identifier for multi-tenancy
    name TEXT,  -- Human-readable name (e.g., "Hero CTA", "Footer Link")
    destination_url TEXT NOT NULL,  -- Where to redirect (e.g., "https://example.com/landing")

    -- UTM Attribution Parameters
    utm_source TEXT DEFAULT 'email',  -- e.g., "klaviyo", "sendgrid"
    utm_medium TEXT DEFAULT 'email',  -- Almost always "email" for this feature
    utm_campaign TEXT,  -- e.g., "welcome_series", "newsletter_dec"
    utm_content TEXT,  -- e.g., "hero_cta", "footer_link"

    -- Metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,  -- User ID who created the link
    is_active INTEGER DEFAULT 1,  -- Soft delete (1 = active, 0 = deactivated)

    -- Foreign key to org_tag_mappings for data integrity
    FOREIGN KEY (org_tag) REFERENCES org_tag_mappings(short_tag) ON DELETE CASCADE
);

-- Primary lookup: by link ID (used in redirect handler)
CREATE INDEX IF NOT EXISTS idx_tracking_links_id_active
ON tracking_links(id, is_active);

-- List links by organization (used in dashboard)
CREATE INDEX IF NOT EXISTS idx_tracking_links_org
ON tracking_links(org_tag, created_at DESC);

-- Filter by campaign (for analytics queries)
CREATE INDEX IF NOT EXISTS idx_tracking_links_campaign
ON tracking_links(org_tag, utm_campaign);
