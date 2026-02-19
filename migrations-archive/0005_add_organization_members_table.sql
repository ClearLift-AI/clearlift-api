-- Migration number: 0005 2025-09-11T12:00:00.000Z

CREATE TABLE IF NOT EXISTS organization_members (
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    invited_by TEXT,
    PRIMARY KEY (organization_id, user_id)
);