-- Grouped migration: platform_connections
-- Tables: platform_connections, oauth_states

-- Table: platform_connections
CREATE TABLE platform_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT,
  connected_by TEXT NOT NULL,
  connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_synced_at DATETIME,
  sync_status TEXT DEFAULT 'pending',
  sync_error TEXT,
  is_active INTEGER DEFAULT 1,
  settings TEXT DEFAULT '{}',
  settings_encrypted TEXT,
  credentials_encrypted TEXT,
  refresh_token_encrypted TEXT,
  expires_at DATETIME,
  scopes TEXT,
  stripe_account_id TEXT,
  stripe_livemode BOOLEAN DEFAULT TRUE,
  filter_rules_count INTEGER DEFAULT 0,
  requires_reconfiguration BOOLEAN DEFAULT FALSE,
  migration_notice TEXT,
  shopify_shop_domain TEXT,
  shopify_shop_id TEXT,
  jobber_account_id TEXT,
  jobber_company_name TEXT,
  needs_reauth BOOLEAN DEFAULT FALSE,
  reauth_reason TEXT,
  reauth_detected_at DATETIME,
  consecutive_auth_failures INTEGER DEFAULT 0,
  UNIQUE(organization_id, platform, account_id)
);

-- Indexes for platform_connections
CREATE INDEX idx_platform_connections_jobber_account_id ON platform_connections(jobber_account_id) WHERE jobber_account_id IS NOT NULL;
CREATE INDEX idx_platform_connections_needs_reauth ON platform_connections(organization_id, needs_reauth) WHERE needs_reauth = TRUE;
CREATE INDEX idx_platform_connections_shopify_shop_domain ON platform_connections(shopify_shop_domain) WHERE shopify_shop_domain IS NOT NULL;

-- Table: oauth_states
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  redirect_uri TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  metadata TEXT DEFAULT '{}',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for oauth_states
CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX idx_oauth_states_user ON oauth_states(user_id);
