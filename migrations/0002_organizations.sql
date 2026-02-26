-- Grouped migration: organizations
-- Tables: organizations, organization_members, terms_acceptance

-- Table: organizations
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings TEXT DEFAULT '{}',
  subscription_tier TEXT DEFAULT 'free',
  attribution_window_days INTEGER DEFAULT 30,
  default_attribution_model TEXT DEFAULT 'last_touch',
  time_decay_half_life_days INTEGER DEFAULT 7,
  conversion_source TEXT DEFAULT 'tag' CHECK(conversion_source IN ('platform', 'tag', 'hybrid')),
  flow_mode TEXT DEFAULT 'simple'
);

-- Indexes for organizations
CREATE INDEX idx_organizations_conversion_source ON organizations(conversion_source);

-- Table: organization_members
CREATE TABLE organization_members (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  invited_by TEXT,
  PRIMARY KEY (organization_id, user_id)
);

-- Table: terms_acceptance
CREATE TABLE terms_acceptance (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  terms_version TEXT NOT NULL DEFAULT '1.0',
  accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for terms_acceptance
CREATE INDEX idx_terms_acceptance_org ON terms_acceptance(organization_id);
CREATE UNIQUE INDEX idx_terms_acceptance_unique ON terms_acceptance(user_id, organization_id, terms_version);
CREATE INDEX idx_terms_acceptance_user ON terms_acceptance(user_id);
