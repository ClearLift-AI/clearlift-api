-- Migration: Add admin_invites table for tracking admin-sent invites
-- This is for audit purposes and tracking admin invite activities

CREATE TABLE IF NOT EXISTS admin_invites (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    sent_by TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    status TEXT NOT NULL DEFAULT 'sent',
    sendgrid_message_id TEXT,
    error_message TEXT,
    FOREIGN KEY (sent_by) REFERENCES users(id)
);

-- Index for audit queries
CREATE INDEX IF NOT EXISTS idx_admin_invites_sent_by ON admin_invites(sent_by);
CREATE INDEX IF NOT EXISTS idx_admin_invites_email ON admin_invites(email);
CREATE INDEX IF NOT EXISTS idx_admin_invites_sent_at ON admin_invites(sent_at);
