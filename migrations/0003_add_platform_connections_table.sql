-- Migration number: 0003 2025-09-11T12:00:00.000Z

CREATE TABLE IF NOT EXISTS platform_connections (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_name TEXT,
    connected_by TEXT NOT NULL,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME,
    sync_status TEXT DEFAULT 'pending',
    sync_error TEXT,
    is_active INTEGER DEFAULT 1,
    settings TEXT DEFAULT '{}',
    UNIQUE(organization_id, platform, account_id)
);