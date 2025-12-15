-- ClearLift D1 Complete Schema (Squashed from migrations 0001-0036)
-- Generated: December 2025
--
-- PURPOSE: Use for fresh deployments only.
-- Existing databases should use incremental migrations in ../migrations/
--
-- This file consolidates all tables, indexes, triggers, and seed data
-- into a single migration for clean installations.

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users table (auth)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_encrypted TEXT,
    email_hash TEXT,
    issuer TEXT NOT NULL,
    access_sub TEXT NOT NULL,
    identity_nonce TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at TEXT,
    name TEXT,
    avatar_url TEXT,
    updated_at DATETIME,
    email_verified BOOLEAN DEFAULT 0,
    email_verified_at DATETIME,
    password_hash TEXT,
    password_salt TEXT,
    password_set_at DATETIME,
    UNIQUE (issuer, access_sub)
);

CREATE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    ip_address TEXT,
    ip_address_encrypted TEXT,
    user_agent TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
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
    conversion_source TEXT DEFAULT 'tag' CHECK(conversion_source IN ('platform', 'tag', 'hybrid'))
);

CREATE INDEX IF NOT EXISTS idx_organizations_conversion_source ON organizations(conversion_source);

-- Organization members
CREATE TABLE IF NOT EXISTS organization_members (
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    invited_by TEXT,
    PRIMARY KEY (organization_id, user_id)
);

-- Invitations
CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    email TEXT NOT NULL,
    email_encrypted TEXT,
    email_hash TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',
    invited_by TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invitations_email_hash ON invitations(email_hash);

-- Org tag mappings (short tags for tracking)
CREATE TABLE IF NOT EXISTS org_tag_mappings (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    short_tag TEXT UNIQUE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_org_tag_mappings_organization_id ON org_tag_mappings(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_tag_mappings_short_tag ON org_tag_mappings(short_tag);
CREATE INDEX IF NOT EXISTS idx_org_tag_mappings_active ON org_tag_mappings(is_active);

-- ============================================================================
-- PLATFORM CONNECTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_connections (
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
    UNIQUE(organization_id, platform, account_id)
);

-- Connector configurations (template for each provider)
CREATE TABLE IF NOT EXISTS connector_configs (
    id TEXT PRIMARY KEY,
    provider TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    logo_url TEXT,
    auth_type TEXT NOT NULL,
    oauth_authorize_url TEXT,
    oauth_token_url TEXT,
    oauth_scopes TEXT,
    requires_api_key BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    config_schema TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Connector filter rules
CREATE TABLE IF NOT EXISTS connector_filter_rules (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    rule_type TEXT DEFAULT 'include',
    operator TEXT DEFAULT 'AND',
    conditions TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (connection_id) REFERENCES platform_connections(id) ON DELETE CASCADE
);

-- ============================================================================
-- ONBOARDING
-- ============================================================================

CREATE TABLE IF NOT EXISTS onboarding_progress (
    user_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    current_step TEXT NOT NULL DEFAULT 'welcome',
    steps_completed TEXT DEFAULT '[]',
    services_connected INTEGER DEFAULT 0,
    first_sync_completed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_onboarding_progress_org ON onboarding_progress(organization_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_step ON onboarding_progress(current_step);

CREATE TABLE IF NOT EXISTS onboarding_steps (
    id TEXT PRIMARY KEY,
    step_name TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    order_index INTEGER NOT NULL,
    is_required BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OAuth state tracking (CSRF protection)
CREATE TABLE IF NOT EXISTS oauth_states (
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

CREATE INDEX IF NOT EXISTS idx_oauth_states_user ON oauth_states(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

-- ============================================================================
-- SYNC & TRACKING
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    connection_id TEXT,
    status TEXT DEFAULT 'pending',
    job_type TEXT DEFAULT 'full',
    started_at DATETIME,
    completed_at DATETIME,
    error_message TEXT,
    records_synced INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT DEFAULT '{}',
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_org ON sync_jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_connection ON sync_jobs(connection_id);

CREATE TABLE IF NOT EXISTS event_sync_watermarks (
    org_tag TEXT PRIMARY KEY,
    last_synced_timestamp TEXT NOT NULL,
    last_synced_event_id TEXT,
    records_synced INTEGER DEFAULT 0,
    last_sync_status TEXT NOT NULL CHECK(last_sync_status IN ('success', 'partial', 'failed')),
    last_sync_error TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_sync_watermarks_status ON event_sync_watermarks(last_sync_status);
CREATE INDEX IF NOT EXISTS idx_event_sync_watermarks_timestamp ON event_sync_watermarks(last_synced_timestamp);

CREATE TRIGGER IF NOT EXISTS update_event_sync_watermarks_timestamp
    AFTER UPDATE ON event_sync_watermarks
    FOR EACH ROW
BEGIN
    UPDATE event_sync_watermarks
    SET updated_at = datetime('now')
    WHERE org_tag = NEW.org_tag;
END;

CREATE TABLE IF NOT EXISTS global_events_watermark (
    id TEXT PRIMARY KEY DEFAULT 'global_events',
    last_synced_timestamp TEXT NOT NULL,
    last_synced_event_id TEXT,
    records_synced_total INTEGER DEFAULT 0,
    records_synced_last_run INTEGER DEFAULT 0,
    last_sync_status TEXT CHECK (last_sync_status IN ('success', 'partial', 'failed', 'in_progress')) DEFAULT 'success',
    last_sync_error TEXT,
    sync_duration_ms INTEGER,
    chunks_processed INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracking configurations
CREATE TABLE IF NOT EXISTS org_tracking_configs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL UNIQUE,
    goals TEXT DEFAULT '{}',
    enable_fingerprinting BOOLEAN DEFAULT TRUE,
    enable_cross_domain_tracking BOOLEAN DEFAULT TRUE,
    enable_performance_tracking BOOLEAN DEFAULT TRUE,
    session_timeout INTEGER DEFAULT 1800000,
    batch_size INTEGER DEFAULT 10,
    batch_timeout INTEGER DEFAULT 5000,
    snippet_complexity TEXT DEFAULT 'simple' CHECK(snippet_complexity IN ('simple', 'advanced', 'custom')),
    custom_snippet TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_org_tracking_configs_org_id ON org_tracking_configs(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_tracking_configs_snippet_complexity ON org_tracking_configs(snippet_complexity);

CREATE TRIGGER IF NOT EXISTS update_org_tracking_configs_timestamp
    AFTER UPDATE ON org_tracking_configs
    FOR EACH ROW
BEGIN
    UPDATE org_tracking_configs
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

-- Tracking domains (for auto-detection)
CREATE TABLE IF NOT EXISTS tracking_domains (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    domain TEXT UNIQUE NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    is_primary BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tracking_domains_domain ON tracking_domains(domain);
CREATE INDEX IF NOT EXISTS idx_tracking_domains_org_id ON tracking_domains(organization_id);

CREATE TRIGGER IF NOT EXISTS update_tracking_domains_timestamp
    AFTER UPDATE ON tracking_domains
    FOR EACH ROW
BEGIN
    UPDATE tracking_domains
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

-- ============================================================================
-- IDENTITY & ATTRIBUTION
-- ============================================================================

CREATE TABLE IF NOT EXISTS identity_mappings (
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

CREATE INDEX IF NOT EXISTS idx_identity_org_anon ON identity_mappings(organization_id, anonymous_id);
CREATE INDEX IF NOT EXISTS idx_identity_org_user ON identity_mappings(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_identity_canonical ON identity_mappings(organization_id, canonical_user_id);
CREATE INDEX IF NOT EXISTS idx_identity_identified_at ON identity_mappings(organization_id, identified_at);

CREATE TABLE IF NOT EXISTS identity_merges (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    organization_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    merged_at TEXT DEFAULT CURRENT_TIMESTAMP,
    merged_by TEXT,
    reason TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_merge_org ON identity_merges(organization_id);
CREATE INDEX IF NOT EXISTS idx_merge_source ON identity_merges(organization_id, source_user_id);
CREATE INDEX IF NOT EXISTS idx_merge_target ON identity_merges(organization_id, target_user_id);

-- Conversion goals
CREATE TABLE IF NOT EXISTS conversion_goals (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT CHECK(type IN ('conversion', 'micro_conversion', 'engagement')) DEFAULT 'conversion',
    trigger_config TEXT NOT NULL DEFAULT '{}',
    default_value_cents INTEGER DEFAULT 0,
    is_primary BOOLEAN DEFAULT FALSE,
    include_in_path BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversion_goals_org ON conversion_goals(organization_id);
CREATE INDEX IF NOT EXISTS idx_conversion_goals_primary ON conversion_goals(organization_id, is_primary);

CREATE TRIGGER IF NOT EXISTS ensure_single_primary_goal
AFTER UPDATE ON conversion_goals
WHEN NEW.is_primary = TRUE
BEGIN
    UPDATE conversion_goals
    SET is_primary = FALSE, updated_at = datetime('now')
    WHERE organization_id = NEW.organization_id
      AND id != NEW.id
      AND is_primary = TRUE;
END;

CREATE TRIGGER IF NOT EXISTS ensure_single_primary_goal_insert
AFTER INSERT ON conversion_goals
WHEN NEW.is_primary = TRUE
BEGIN
    UPDATE conversion_goals
    SET is_primary = FALSE, updated_at = datetime('now')
    WHERE organization_id = NEW.organization_id
      AND id != NEW.id
      AND is_primary = TRUE;
END;

-- Event filters
CREATE TABLE IF NOT EXISTS event_filters (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    filter_type TEXT CHECK(filter_type IN ('include', 'exclude')) DEFAULT 'exclude',
    rules TEXT NOT NULL DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_filters_org ON event_filters(organization_id);
CREATE INDEX IF NOT EXISTS idx_event_filters_active ON event_filters(organization_id, is_active);

-- ============================================================================
-- AI OPTIMIZATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_optimization_settings (
    org_id TEXT PRIMARY KEY,
    growth_strategy TEXT NOT NULL DEFAULT 'balanced' CHECK(growth_strategy IN ('lean', 'balanced', 'bold')),
    budget_optimization TEXT NOT NULL DEFAULT 'moderate' CHECK(budget_optimization IN ('conservative', 'moderate', 'aggressive')),
    ai_control TEXT NOT NULL DEFAULT 'copilot' CHECK(ai_control IN ('copilot', 'autopilot')),
    daily_cap_cents INTEGER,
    monthly_cap_cents INTEGER,
    pause_threshold_percent INTEGER,
    last_recommendation_at TEXT,
    conversion_source TEXT DEFAULT 'tag' CHECK(conversion_source IN ('ad_platforms', 'tag', 'connectors')),
    custom_instructions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_settings_last_recommendation ON ai_optimization_settings(last_recommendation_at, budget_optimization);
CREATE INDEX IF NOT EXISTS idx_ai_settings_conversion_source ON ai_optimization_settings(conversion_source);

-- ============================================================================
-- AUDIT & SECURITY
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    user_id TEXT,
    organization_id TEXT,
    session_token_hash TEXT,
    action TEXT NOT NULL,
    method TEXT,
    path TEXT,
    resource_type TEXT,
    resource_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    request_id TEXT,
    success INTEGER DEFAULT 1,
    status_code INTEGER,
    error_code TEXT,
    error_message TEXT,
    response_time_ms INTEGER,
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

CREATE TABLE IF NOT EXISTS auth_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    user_id TEXT,
    email TEXT,
    auth_method TEXT,
    provider TEXT,
    ip_address TEXT,
    user_agent TEXT,
    success INTEGER DEFAULT 1,
    failure_reason TEXT,
    session_id TEXT,
    session_created INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_timestamp ON auth_audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_auth_audit_event ON auth_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_auth_audit_success ON auth_audit_logs(success);

CREATE TABLE IF NOT EXISTS data_access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    access_type TEXT NOT NULL,
    data_source TEXT NOT NULL,
    table_name TEXT,
    query_hash TEXT,
    filters_applied TEXT DEFAULT '{}',
    records_accessed INTEGER,
    fields_accessed TEXT DEFAULT '[]',
    query_time_ms INTEGER,
    export_format TEXT,
    export_destination TEXT,
    contains_pii INTEGER DEFAULT 0,
    data_classification TEXT DEFAULT 'internal',
    request_id TEXT,
    ip_address TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_data_access_user ON data_access_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_data_access_org ON data_access_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_data_access_timestamp ON data_access_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_data_access_pii ON data_access_logs(contains_pii);

CREATE TABLE IF NOT EXISTS config_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    organization_id TEXT,
    config_type TEXT NOT NULL,
    config_id TEXT,
    action TEXT NOT NULL,
    field_name TEXT,
    old_value TEXT,
    new_value TEXT,
    requires_approval INTEGER DEFAULT 0,
    approved_by TEXT,
    approved_at DATETIME,
    request_id TEXT,
    ip_address TEXT,
    reason TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_config_audit_user ON config_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_config_audit_org ON config_audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_config_audit_timestamp ON config_audit_logs(timestamp);

CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    severity TEXT NOT NULL,
    event_type TEXT NOT NULL,
    user_id TEXT,
    organization_id TEXT,
    threat_indicator TEXT,
    threat_source TEXT,
    automated_response TEXT,
    manual_review_required INTEGER DEFAULT 0,
    request_data TEXT,
    metadata TEXT DEFAULT '{}',
    ip_address TEXT,
    user_agent TEXT,
    request_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_security_events_review ON security_events(manual_review_required);

-- ============================================================================
-- MISC TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used BOOLEAN DEFAULT 0,
    used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_token ON email_verification_tokens(token);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);

CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    phone TEXT,
    source TEXT,
    utm TEXT,
    referrer_id TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'contacted', 'converted', 'rejected')),
    attempt_count INTEGER NOT NULL DEFAULT 1,
    last_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waitlist_attempt_count ON waitlist(attempt_count DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    last_request TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_end ON rate_limits(window_end);

CREATE TABLE IF NOT EXISTS consent_configurations (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    organization_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'opt_out' CHECK(mode IN ('opt_in', 'opt_out', 'implicit')),
    default_consent TEXT NOT NULL DEFAULT '{}',
    required_categories TEXT DEFAULT '["essential"]',
    cookie_policy_url TEXT,
    privacy_policy_url TEXT,
    banner_config TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_consent_config_org ON consent_configurations(organization_id);

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Connector configurations
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
    0,
    1,
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
    0,
    1,
    '{"ad_account_id": {"type": "string", "required": true, "description": "Facebook Ad Account ID"}}'
  ),
  (
    'stripe-001',
    'stripe',
    'Stripe',
    'https://images.ctfassets.net/fzn2n1nzq965/HTTOloNPhisV9P4hlMPNA/cacf1bb88b9fc492dfad34378d844280/Stripe_icon_-_square.svg',
    'api_key',
    NULL,
    NULL,
    NULL,
    1,
    1,
    '{"api_key":{"type":"string","required":true,"description":"Stripe Secret Key (sk_test_ or sk_live_)","pattern":"^sk_(test_|live_)[a-zA-Z0-9]{24,}$","secret":true},"lookback_days":{"type":"number","required":false,"description":"Days of historical data to sync (payment_intents only, succeeded status)","default":30,"minimum":1,"maximum":365},"auto_sync":{"type":"boolean","required":false,"description":"Enable automatic syncing every 15 minutes","default":true}}'
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
    0,
    1,
    '{"advertiser_id": {"type": "string", "required": true, "description": "TikTok Advertiser ID"}}'
  )
ON CONFLICT (provider) DO NOTHING;

-- Onboarding steps
INSERT INTO onboarding_steps (id, step_name, display_name, description, order_index, is_required) VALUES
  ('step-001', 'welcome', 'Welcome', 'Introduction to ClearLift', 1, 1),
  ('step-002', 'connect_services', 'Connect Services', 'Connect your advertising platforms', 2, 1),
  ('step-003', 'first_sync', 'First Sync', 'Complete your first data sync', 3, 1),
  ('step-004', 'completed', 'Setup Complete', 'Onboarding finished', 4, 1)
ON CONFLICT (step_name) DO NOTHING;

-- Initialize global events watermark
INSERT INTO global_events_watermark (id, last_synced_timestamp, last_sync_status)
VALUES ('global_events', datetime('now', '-1 hour'), 'success')
ON CONFLICT (id) DO NOTHING;
