-- Identity Mappings Table
-- Links anonymous_id (cookie/device) to user_id (identified user)
-- D1 is the authoritative source; Supabase gets summary data via cron

CREATE TABLE IF NOT EXISTS identity_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_user_id TEXT,              -- NULL = this user_id IS canonical; non-null = points to master
  identified_at TEXT NOT NULL,         -- When the link was established
  first_seen_at TEXT,                  -- First event timestamp with this anonymous_id
  source TEXT DEFAULT 'identify',      -- 'identify', 'login', 'merge', 'manual'
  confidence REAL DEFAULT 1.0,         -- For probabilistic matching (future)
  metadata TEXT,                       -- JSON for additional context
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(organization_id, anonymous_id, user_id)
);

-- Fast lookups in both directions
CREATE INDEX IF NOT EXISTS idx_identity_org_anon ON identity_mappings(organization_id, anonymous_id);
CREATE INDEX IF NOT EXISTS idx_identity_org_user ON identity_mappings(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_identity_canonical ON identity_mappings(organization_id, canonical_user_id);
CREATE INDEX IF NOT EXISTS idx_identity_identified_at ON identity_mappings(organization_id, identified_at);

-- Identity merge history for audit trail
CREATE TABLE IF NOT EXISTS identity_merges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_user_id TEXT NOT NULL,        -- The user_id being merged FROM
  target_user_id TEXT NOT NULL,        -- The user_id being merged INTO (canonical)
  merged_at TEXT DEFAULT CURRENT_TIMESTAMP,
  merged_by TEXT,                      -- user_id or 'system' for auto-merge
  reason TEXT,                         -- 'same_email', 'sso_link', 'manual', etc.

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_merge_org ON identity_merges(organization_id);
CREATE INDEX IF NOT EXISTS idx_merge_source ON identity_merges(organization_id, source_user_id);
CREATE INDEX IF NOT EXISTS idx_merge_target ON identity_merges(organization_id, target_user_id);
