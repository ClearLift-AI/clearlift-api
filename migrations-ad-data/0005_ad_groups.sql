-- Migration number: 0005
-- Ad groups performance data

CREATE TABLE IF NOT EXISTS ad_groups (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_group_id TEXT NOT NULL,
    ad_group_name TEXT NOT NULL,
    date DATE NOT NULL,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    spend REAL DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, campaign_id, ad_group_id, date)
);