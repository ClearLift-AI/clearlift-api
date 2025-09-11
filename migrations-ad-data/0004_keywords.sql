-- Migration number: 0004
-- Keywords performance data

CREATE TABLE IF NOT EXISTS keywords (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ad_group_id TEXT,
    keyword TEXT NOT NULL,
    match_type TEXT,
    date DATE NOT NULL,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    spend REAL DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    quality_score REAL,
    position_avg REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, campaign_id, keyword, date)
);