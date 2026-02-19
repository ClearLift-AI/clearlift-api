-- Migration number: 0031 2025-12-01
-- Fix invitations table: rename token to invite_code, make email nullable for shareable links

-- SQLite doesn't support ALTER COLUMN or RENAME COLUMN in older versions
-- We need to recreate the table

-- Step 1: Create new table with correct schema
CREATE TABLE IF NOT EXISTS invitations_new (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    email TEXT,  -- Now nullable for shareable invite links
    role TEXT NOT NULL DEFAULT 'viewer',
    invited_by TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,  -- Renamed from token
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    email_encrypted TEXT,
    email_hash TEXT,
    -- New field for shareable links
    is_shareable INTEGER DEFAULT 0,  -- 1 = anyone can use, 0 = specific email only
    max_uses INTEGER,  -- NULL = unlimited, or specific number
    use_count INTEGER DEFAULT 0
);

-- Step 2: Copy data from old table
INSERT INTO invitations_new (
    id, organization_id, email, role, invited_by,
    invite_code, expires_at, accepted_at, created_at,
    email_encrypted, email_hash, is_shareable, max_uses, use_count
)
SELECT
    id, organization_id, email, role, invited_by,
    token, expires_at, accepted_at, created_at,
    email_encrypted, email_hash, 0, NULL, 0
FROM invitations;

-- Step 3: Drop old table
DROP TABLE invitations;

-- Step 4: Rename new table
ALTER TABLE invitations_new RENAME TO invitations;

-- Step 5: Recreate indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_invite_code ON invitations(invite_code);
CREATE INDEX IF NOT EXISTS idx_invitations_email_hash ON invitations(email_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_org_id ON invitations(organization_id);
