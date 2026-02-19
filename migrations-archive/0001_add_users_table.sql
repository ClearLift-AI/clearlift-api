-- Migration number: 0001 2025-06-19T18:13:02.648Z

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    issuer TEXT NOT NULL,
    access_sub TEXT NOT NULL,
    identity_nonce TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at TEXT,
    name TEXT,
    avatar_url TEXT,
    updated_at DATETIME,
    UNIQUE (issuer, access_sub)
);