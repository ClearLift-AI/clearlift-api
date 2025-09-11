-- Migration number: 0003
-- Platform accounts for managing advertising platform connections

CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_name TEXT,
    currency TEXT DEFAULT 'USD',
    timezone TEXT DEFAULT 'America/New_York',
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME,
    sync_status TEXT DEFAULT 'active',
    metadata TEXT,
    UNIQUE(organization_id, platform, account_id)
);