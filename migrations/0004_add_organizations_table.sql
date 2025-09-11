-- Migration number: 0004 2025-09-11T12:00:00.000Z

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    settings TEXT DEFAULT '{}',
    subscription_tier TEXT DEFAULT 'free'
);