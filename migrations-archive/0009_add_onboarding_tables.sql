-- Migration number: 0009 2025-10-10T00:00:00.000Z
-- Add onboarding state tracking and OAuth credentials

-- Onboarding steps tracking
CREATE TABLE IF NOT EXISTS onboarding_progress (
    user_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    current_step TEXT NOT NULL DEFAULT 'welcome', -- welcome|connect_services|first_sync|completed
    steps_completed TEXT DEFAULT '[]', -- JSON array of completed step names
    services_connected INTEGER DEFAULT 0,
    first_sync_completed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- OAuth state tracking (for CSRF protection)
CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    provider TEXT NOT NULL, -- google|facebook|tiktok|etc
    redirect_uri TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    metadata TEXT DEFAULT '{}', -- JSON for additional context
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Update platform_connections to add encrypted credentials
-- (extends existing table from migration 0003)
ALTER TABLE platform_connections ADD COLUMN credentials_encrypted TEXT;
ALTER TABLE platform_connections ADD COLUMN refresh_token_encrypted TEXT;
ALTER TABLE platform_connections ADD COLUMN expires_at DATETIME;
ALTER TABLE platform_connections ADD COLUMN scopes TEXT; -- JSON array of granted scopes

-- Connector configuration templates
CREATE TABLE IF NOT EXISTS connector_configs (
    id TEXT PRIMARY KEY,
    provider TEXT UNIQUE NOT NULL, -- google|facebook|stripe|tiktok
    name TEXT NOT NULL,
    logo_url TEXT,
    auth_type TEXT NOT NULL, -- oauth2|api_key|basic
    oauth_authorize_url TEXT,
    oauth_token_url TEXT,
    oauth_scopes TEXT, -- JSON array of default scopes
    requires_api_key BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    config_schema TEXT, -- JSON schema for provider-specific config
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sync job queue metadata (to be consumed by queue worker)
CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    connection_id TEXT NOT NULL, -- FK to platform_connections.id
    status TEXT DEFAULT 'pending', -- pending|running|completed|failed
    job_type TEXT DEFAULT 'full', -- full|incremental
    started_at DATETIME,
    completed_at DATETIME,
    error_message TEXT,
    records_synced INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT DEFAULT '{}', -- JSON for sync details
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (connection_id) REFERENCES platform_connections(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_org ON onboarding_progress(organization_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_step ON onboarding_progress(current_step);
CREATE INDEX IF NOT EXISTS idx_oauth_states_user ON oauth_states(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_org ON sync_jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_connection ON sync_jobs(connection_id);

-- Insert default connector configurations
INSERT INTO connector_configs (id, provider, name, logo_url, auth_type, oauth_authorize_url, oauth_token_url, oauth_scopes, requires_api_key, is_active, config_schema) VALUES
  (
    'google-ads-001',
    'google',
    'Google Ads',
    'https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png',
    'oauth2',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://oauth2.googleapis.com/token',
    '["https://www.googleapis.com/auth/adwords"]',
    false,
    true,
    '{"customer_id": {"type": "string", "required": true, "description": "Google Ads Customer ID"}}'
  ),
  (
    'facebook-ads-001',
    'facebook',
    'Facebook Ads',
    'https://static.xx.fbcdn.net/rsrc.php/v3/yF/r/mMqfBX1FkWN.png',
    'oauth2',
    'https://www.facebook.com/v18.0/dialog/oauth',
    'https://graph.facebook.com/v18.0/oauth/access_token',
    '["ads_read", "ads_management"]',
    false,
    true,
    '{"ad_account_id": {"type": "string", "required": true, "description": "Facebook Ad Account ID"}}'
  ),
  (
    'stripe-001',
    'stripe',
    'Stripe',
    'https://images.ctfassets.net/fzn2n1nzq965/HTTOloNPhisV9P4hlMPNA/cacf1bb88b9fc492dfad34378d844280/Stripe_icon_-_square.svg',
    'api_key',
    null,
    null,
    null,
    true,
    true,
    '{"api_key": {"type": "string", "required": true, "description": "Stripe Secret Key", "secret": true}}'
  ),
  (
    'tiktok-ads-001',
    'tiktok',
    'TikTok Ads',
    'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/tiktok/webapp/main/webapp-desktop/45f769d53d2c40abadf0.png',
    'oauth2',
    'https://business-api.tiktok.com/portal/auth',
    'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/',
    '["ads:read"]',
    false,
    true,
    '{"advertiser_id": {"type": "string", "required": true, "description": "TikTok Advertiser ID"}}'
  );

-- Insert default onboarding steps (as reference - actual tracking is in onboarding_progress)
-- This helps define the expected flow
CREATE TABLE IF NOT EXISTS onboarding_steps (
    id TEXT PRIMARY KEY,
    step_name TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    order_index INTEGER NOT NULL,
    is_required BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO onboarding_steps (id, step_name, display_name, description, order_index, is_required) VALUES
  ('step-001', 'welcome', 'Welcome', 'Introduction to ClearLift', 1, true),
  ('step-002', 'connect_services', 'Connect Services', 'Connect your advertising platforms', 2, true),
  ('step-003', 'first_sync', 'First Sync', 'Complete your first data sync', 3, true),
  ('step-004', 'completed', 'Setup Complete', 'Onboarding finished', 4, true);
