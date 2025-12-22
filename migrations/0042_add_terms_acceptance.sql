-- Migration: Add terms_acceptance table for clickwrap agreement tracking
-- Created: 2025-12-21
--
-- Tracks user acceptance of Terms of Service and Data Processing Agreement
-- Required for GDPR compliance documentation and legal defensibility

CREATE TABLE IF NOT EXISTS terms_acceptance (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,

  -- Terms version tracking (allows future updates)
  terms_version TEXT NOT NULL DEFAULT '1.0',

  -- Acceptance details
  accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT,

  -- Foreign keys
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_terms_acceptance_user ON terms_acceptance(user_id);
CREATE INDEX IF NOT EXISTS idx_terms_acceptance_org ON terms_acceptance(organization_id);

-- Unique constraint: one acceptance per user+org+version
CREATE UNIQUE INDEX IF NOT EXISTS idx_terms_acceptance_unique
  ON terms_acceptance(user_id, organization_id, terms_version);
