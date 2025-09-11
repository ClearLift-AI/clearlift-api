-- Migration number: 0002
-- Sync history tracking for platform data synchronization

CREATE TABLE IF NOT EXISTS sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    sync_type TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT,
    records_synced INTEGER DEFAULT 0,
    error_message TEXT,
    date_from DATE,
    date_to DATE
);