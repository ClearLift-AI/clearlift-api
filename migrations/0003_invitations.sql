-- Table: invitations
CREATE TABLE "invitations" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  invited_by TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  email_encrypted TEXT,
  email_hash TEXT,
  is_shareable INTEGER DEFAULT 0,
  max_uses INTEGER,
  use_count INTEGER DEFAULT 0
);

-- Indexes for invitations
CREATE INDEX idx_invitations_email_hash ON invitations(email_hash);
CREATE UNIQUE INDEX idx_invitations_invite_code ON invitations(invite_code);
CREATE INDEX idx_invitations_org_id ON invitations(organization_id);
