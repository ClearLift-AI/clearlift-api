-- Grouped migration: identity
-- Tables: identity_mappings, identity_merges

-- Table: identity_mappings
CREATE TABLE identity_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_user_id TEXT,
  identified_at TEXT NOT NULL,
  first_seen_at TEXT,
  source TEXT DEFAULT 'identify',
  confidence REAL DEFAULT 1.0,
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, anonymous_id, user_id)
);

-- Indexes for identity_mappings
CREATE INDEX idx_identity_canonical ON identity_mappings(organization_id, canonical_user_id);
CREATE INDEX idx_identity_identified_at ON identity_mappings(organization_id, identified_at);
CREATE INDEX idx_identity_org_anon ON identity_mappings(organization_id, anonymous_id);
CREATE INDEX idx_identity_org_user ON identity_mappings(organization_id, user_id);

-- Table: identity_merges
CREATE TABLE identity_merges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  merged_at TEXT DEFAULT CURRENT_TIMESTAMP,
  merged_by TEXT,
  reason TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for identity_merges
CREATE INDEX idx_merge_org ON identity_merges(organization_id);
CREATE INDEX idx_merge_source ON identity_merges(organization_id, source_user_id);
CREATE INDEX idx_merge_target ON identity_merges(organization_id, target_user_id);
