-- ============================================================================
-- adbliss-core: Consolidated Core Database Schema
-- ============================================================================
-- Merges: old DB + AI_DB into a single database
-- Excludes: identity_mappings, identity_merges (-> analytics)
-- Excludes: webhook_events (-> analytics)
-- Excludes: shard_routing, shard_migration_log (dropped)
-- ============================================================================

-- ============================================================================
-- AUTH (5 tables)
-- ============================================================================

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  issuer TEXT NOT NULL,
  access_sub TEXT NOT NULL,
  identity_nonce TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  name TEXT,
  avatar_url TEXT,
  updated_at DATETIME,
  email_encrypted TEXT,
  email_hash TEXT,
  password_hash TEXT,
  email_verified INTEGER DEFAULT 0,
  email_verification_token TEXT,
  email_verified_at DATETIME,
  is_admin INTEGER NOT NULL DEFAULT 0,
  UNIQUE (issuer, access_sub)
);

CREATE INDEX idx_users_email_hash ON users(email_hash);
CREATE INDEX idx_users_email_verification_token ON users(email_verification_token);
CREATE INDEX idx_users_email_verified ON users(email_verified);
CREATE INDEX idx_users_is_admin ON users(is_admin);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  ip_address_encrypted TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE password_reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  used INTEGER DEFAULT 0,
  used_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);
CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);

CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  used BOOLEAN DEFAULT 0,
  used_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token);
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);

CREATE TABLE waitlist (
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT
);

CREATE INDEX idx_waitlist_attempt_count ON waitlist(attempt_count DESC);
CREATE INDEX idx_waitlist_created_at ON waitlist(created_at DESC);
CREATE INDEX idx_waitlist_email ON waitlist(email);
CREATE INDEX idx_waitlist_status ON waitlist(status);

-- ============================================================================
-- ORGS & MEMBERSHIP (4 tables)
-- ============================================================================

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

CREATE INDEX idx_organizations_conversion_source ON organizations(conversion_source);

CREATE TABLE organization_members (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  invited_by TEXT,
  PRIMARY KEY (organization_id, user_id)
);

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

CREATE INDEX idx_terms_acceptance_org ON terms_acceptance(organization_id);
CREATE UNIQUE INDEX idx_terms_acceptance_unique ON terms_acceptance(user_id, organization_id, terms_version);
CREATE INDEX idx_terms_acceptance_user ON terms_acceptance(user_id);

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

CREATE INDEX idx_invitations_email_hash ON invitations(email_hash);
CREATE UNIQUE INDEX idx_invitations_invite_code ON invitations(invite_code);
CREATE INDEX idx_invitations_org_id ON invitations(organization_id);

-- ============================================================================
-- ONBOARDING (2 tables)
-- ============================================================================

CREATE TABLE onboarding_progress (
  user_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  current_step TEXT NOT NULL DEFAULT 'welcome',
  steps_completed TEXT DEFAULT '[]',
  services_connected INTEGER DEFAULT 0,
  first_sync_completed BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  has_verified_tag INTEGER DEFAULT 0,
  has_defined_goal INTEGER DEFAULT 0,
  verified_domains_count INTEGER DEFAULT 0,
  goals_count INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_onboarding_progress_org ON onboarding_progress(organization_id);
CREATE INDEX idx_onboarding_progress_step ON onboarding_progress(current_step);

CREATE TABLE onboarding_steps (
  id TEXT PRIMARY KEY,
  step_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  order_index INTEGER NOT NULL,
  is_required BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- CONNECTIONS (4 tables)
-- ============================================================================

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

CREATE INDEX idx_platform_connections_jobber_account_id ON platform_connections(jobber_account_id) WHERE jobber_account_id IS NOT NULL;
CREATE INDEX idx_platform_connections_needs_reauth ON platform_connections(organization_id, needs_reauth) WHERE needs_reauth = TRUE;
CREATE INDEX idx_platform_connections_shopify_shop_domain ON platform_connections(shopify_shop_domain) WHERE shopify_shop_domain IS NOT NULL;

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

CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX idx_oauth_states_user ON oauth_states(user_id);

CREATE TABLE connector_configs (
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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  connector_type TEXT CHECK (connector_type IN ('ad_platform', 'crm', 'communication', 'ecommerce', 'payments', 'support', 'scheduling', 'forms', 'events', 'analytics', 'accounting', 'attribution', 'reviews', 'affiliate', 'social', 'field_service', 'revenue', 'email', 'sms')) DEFAULT 'payments',
  category TEXT CHECK (category IN ('advertising', 'sales', 'marketing', 'commerce', 'operations', 'analytics', 'finance', 'communication', 'field_service', 'payments', 'ecommerce', 'crm')) DEFAULT 'commerce',
  description TEXT,
  documentation_url TEXT,
  icon_name TEXT,
  icon_color TEXT DEFAULT '#6B7280',
  sort_order INTEGER DEFAULT 100,
  supports_sync BOOLEAN DEFAULT TRUE,
  supports_realtime BOOLEAN DEFAULT FALSE,
  supports_webhooks BOOLEAN DEFAULT FALSE,
  is_beta BOOLEAN DEFAULT FALSE,
  events_schema TEXT,
  default_concurrency INTEGER DEFAULT 2,
  rate_limit_per_hour INTEGER,
  default_lookback_days INTEGER DEFAULT 90,
  default_sync_interval_hours INTEGER DEFAULT 24,
  theme_bg_color TEXT,
  theme_border_color TEXT,
  theme_text_color TEXT,
  has_actual_value BOOLEAN DEFAULT FALSE,
  value_field TEXT,
  permissions_description TEXT,
  platform_id TEXT
);

CREATE INDEX idx_connector_configs_active ON connector_configs(is_active, connector_type);
CREATE INDEX idx_connector_configs_category ON connector_configs(category);
CREATE INDEX idx_connector_configs_platform_id ON connector_configs(platform_id);
CREATE INDEX idx_connector_configs_type ON connector_configs(connector_type);

CREATE TABLE connector_filter_rules (
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
-- TAG TRACKING (6 tables)
-- ============================================================================

CREATE TABLE org_tag_mappings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  short_tag TEXT UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_org_tag_mappings_active ON org_tag_mappings(is_active);
CREATE INDEX idx_org_tag_mappings_organization_id ON org_tag_mappings(organization_id);
CREATE INDEX idx_org_tag_mappings_short_tag ON org_tag_mappings(short_tag);

CREATE TABLE org_tracking_configs (
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

CREATE INDEX idx_org_tracking_configs_org_id ON org_tracking_configs(organization_id);
CREATE INDEX idx_org_tracking_configs_snippet_complexity ON org_tracking_configs(snippet_complexity);

CREATE TRIGGER update_org_tracking_configs_timestamp
    AFTER UPDATE ON org_tracking_configs
    FOR EACH ROW
BEGIN
    UPDATE org_tracking_configs
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

CREATE TABLE tracking_domains (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  domain TEXT UNIQUE NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_tracking_domains_domain ON tracking_domains(domain);
CREATE INDEX idx_tracking_domains_org_id ON tracking_domains(organization_id);

CREATE TRIGGER update_tracking_domains_timestamp
    AFTER UPDATE ON tracking_domains
    FOR EACH ROW
BEGIN
    UPDATE tracking_domains
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

CREATE TABLE tracking_links (
  id TEXT PRIMARY KEY,
  org_tag TEXT NOT NULL,
  name TEXT,
  destination_url TEXT NOT NULL,
  utm_source TEXT DEFAULT 'email',
  utm_medium TEXT DEFAULT 'email',
  utm_campaign TEXT,
  utm_content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (org_tag) REFERENCES org_tag_mappings(short_tag) ON DELETE CASCADE
);

CREATE INDEX idx_tracking_links_campaign ON tracking_links(org_tag, utm_campaign);
CREATE INDEX idx_tracking_links_id_active ON tracking_links(id, is_active);
CREATE INDEX idx_tracking_links_org ON tracking_links(org_tag, created_at DESC);

CREATE TABLE script_hashes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE,
  hash TEXT UNIQUE NOT NULL,
  org_tag TEXT NOT NULL,
  version TEXT DEFAULT '3.0.0',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_script_hashes_hash ON script_hashes(hash);

CREATE TRIGGER update_script_hashes_timestamp
    AFTER UPDATE ON script_hashes
    FOR EACH ROW
BEGIN
    UPDATE script_hashes
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

CREATE TABLE consent_configurations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_tag TEXT NOT NULL UNIQUE,
  consent_mode TEXT NOT NULL DEFAULT 'auto',
  consent_required BOOLEAN DEFAULT 1,
  privacy_policy_url TEXT,
  banner_enabled BOOLEAN DEFAULT 1,
  banner_position TEXT DEFAULT 'bottom',
  banner_style TEXT DEFAULT 'minimal',
  banner_text TEXT,
  button_accept TEXT DEFAULT 'Accept',
  button_reject TEXT DEFAULT 'Reject',
  button_customize TEXT DEFAULT 'Customize',
  primary_color TEXT DEFAULT '#667eea',
  enable_analytics BOOLEAN DEFAULT 1,
  enable_marketing BOOLEAN DEFAULT 0,
  enable_preferences BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (org_tag) REFERENCES org_tag_mappings(short_tag)
);

CREATE INDEX idx_consent_config_org_tag ON consent_configurations(org_tag);

-- ============================================================================
-- FLOW BUILDER (4 tables)
-- ============================================================================
-- Goals/conversion_configs removed — conversion criteria now live in
-- platform_connections.settings JSON (see connection-configs.ts)

CREATE TABLE acquisition_instances (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'archived')),
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_acquisition_instances_org ON acquisition_instances(organization_id);

CREATE TABLE interaction_nodes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  goal_id TEXT,
  node_type TEXT NOT NULL CHECK(node_type IN ('page', 'event', 'goal', 'conversion', 'entry', 'exit')),
  label TEXT NOT NULL,
  position_x REAL DEFAULT 0,
  position_y REAL DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_interaction_nodes_org ON interaction_nodes(organization_id);

CREATE TABLE interaction_edges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  edge_type TEXT DEFAULT 'flow',
  label TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_node_id) REFERENCES interaction_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES interaction_nodes(id) ON DELETE CASCADE
);

CREATE INDEX idx_interaction_edges_org ON interaction_edges(organization_id);
CREATE INDEX idx_interaction_edges_source ON interaction_edges(source_node_id);
CREATE INDEX idx_interaction_edges_target ON interaction_edges(target_node_id);

CREATE TABLE funnel_metadata (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL UNIQUE,
  site_root_url TEXT,
  business_type TEXT,
  traffic_sources TEXT DEFAULT '[]',
  conversion_events TEXT DEFAULT '[]',
  journey_steps TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- ============================================================================
-- SETTINGS (4 tables)
-- ============================================================================

CREATE TABLE ai_optimization_settings (
  org_id TEXT PRIMARY KEY,
  growth_strategy TEXT NOT NULL DEFAULT 'balanced' CHECK(growth_strategy IN ('lean', 'balanced', 'bold')),
  budget_optimization TEXT NOT NULL DEFAULT 'moderate' CHECK(budget_optimization IN ('conservative', 'moderate', 'aggressive')),
  ai_control TEXT NOT NULL DEFAULT 'copilot' CHECK(ai_control IN ('copilot', 'autopilot')),
  daily_cap_cents INTEGER,
  monthly_cap_cents INTEGER,
  pause_threshold_percent INTEGER,
  last_recommendation_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  conversion_source TEXT DEFAULT 'tag' CHECK(conversion_source IN ('ad_platforms', 'tag', 'connectors')),
  custom_instructions TEXT,
  llm_default_provider TEXT DEFAULT 'auto',
  llm_claude_model TEXT DEFAULT 'haiku',
  llm_gemini_model TEXT DEFAULT 'flash',
  llm_max_recommendations INTEGER DEFAULT 3,
  llm_enable_exploration INTEGER DEFAULT 1,
  disabled_conversion_sources TEXT DEFAULT '[]',
  business_type TEXT DEFAULT 'lead_gen' CHECK(business_type IN ('ecommerce', 'lead_gen', 'saas')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_optimization_settings_business_type ON ai_optimization_settings(org_id, business_type);
CREATE INDEX idx_ai_settings_conversion_source ON ai_optimization_settings(conversion_source);
CREATE INDEX idx_ai_settings_last_recommendation ON ai_optimization_settings(last_recommendation_at, budget_optimization);

CREATE TABLE dashboard_layouts (
  organization_id TEXT PRIMARY KEY,
  layout_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE stripe_metadata_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  key_path TEXT NOT NULL,
  sample_values TEXT,
  value_type TEXT,
  occurrence_count INTEGER DEFAULT 1,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, object_type, key_path)
);

CREATE INDEX idx_stripe_metadata_keys_connection ON stripe_metadata_keys(connection_id);
CREATE INDEX idx_stripe_metadata_keys_object_type ON stripe_metadata_keys(connection_id, object_type);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  last_request TEXT NOT NULL
);

CREATE INDEX idx_rate_limits_window_end ON rate_limits(window_end);

-- ============================================================================
-- SYNC (4 tables)
-- ============================================================================

CREATE TABLE "sync_jobs" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  job_type TEXT DEFAULT 'full',
  started_at DATETIME,
  completed_at DATETIME,
  error_message TEXT,
  records_synced INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT DEFAULT '{}',
  updated_at DATETIME,
  current_phase TEXT,
  total_records INTEGER,
  progress_percentage INTEGER DEFAULT 0,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX idx_sync_jobs_connection_status ON sync_jobs(connection_id, status);
CREATE INDEX idx_sync_jobs_status_created ON sync_jobs(status, created_at);

CREATE TABLE event_sync_watermarks (
  org_tag TEXT PRIMARY KEY,
  last_synced_timestamp TEXT NOT NULL,
  last_synced_event_id TEXT,
  records_synced INTEGER DEFAULT 0,
  last_sync_status TEXT NOT NULL CHECK(last_sync_status IN ('success', 'partial', 'failed')),
  last_sync_error TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_event_sync_watermarks_status ON event_sync_watermarks(last_sync_status);
CREATE INDEX idx_event_sync_watermarks_timestamp ON event_sync_watermarks(last_synced_timestamp);

CREATE TRIGGER update_event_sync_watermarks_timestamp
    AFTER UPDATE ON event_sync_watermarks
    FOR EACH ROW
BEGIN
    UPDATE event_sync_watermarks
    SET updated_at = datetime('now')
    WHERE org_tag = NEW.org_tag;
END;

CREATE TABLE active_event_workflows (
  org_tag TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_active_event_workflows_created ON active_event_workflows(created_at);

CREATE TABLE active_shopify_workflows (
  connection_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_active_shopify_workflows_created ON active_shopify_workflows(created_at);

-- ============================================================================
-- WEBHOOKS CONFIG (1 table - webhook_events moved to analytics)
-- ============================================================================

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  endpoint_secret TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  events_subscribed TEXT,
  last_received_at TEXT,
  receive_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connector)
);

CREATE INDEX idx_webhook_endpoints_connector ON webhook_endpoints(connector) WHERE is_active = 1;
CREATE INDEX idx_webhook_endpoints_org ON webhook_endpoints(organization_id);

-- ============================================================================
-- ADMIN (4 tables)
-- ============================================================================

CREATE TABLE admin_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL CHECK (task_type IN ('follow_up', 'investigation', 'support', 'bug', 'feature', 'other')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  connection_id TEXT,
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_date DATETIME,
  reminder_at DATETIME,
  resolution_notes TEXT,
  resolved_at DATETIME,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_admin_tasks_assigned ON admin_tasks(assigned_to);
CREATE INDEX idx_admin_tasks_created_at ON admin_tasks(created_at DESC);
CREATE INDEX idx_admin_tasks_created_by ON admin_tasks(created_by);
CREATE INDEX idx_admin_tasks_due ON admin_tasks(due_date);
CREATE INDEX idx_admin_tasks_org ON admin_tasks(organization_id);
CREATE INDEX idx_admin_tasks_priority ON admin_tasks(priority);
CREATE INDEX idx_admin_tasks_status ON admin_tasks(status);

CREATE TABLE admin_task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES admin_tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_admin_task_comments_task ON admin_task_comments(task_id);

CREATE TABLE admin_invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'sent',
  sendgrid_message_id TEXT,
  error_message TEXT,
  FOREIGN KEY (sent_by) REFERENCES users(id)
);

CREATE INDEX idx_admin_invites_email ON admin_invites(email);
CREATE INDEX idx_admin_invites_sent_at ON admin_invites(sent_at);
CREATE INDEX idx_admin_invites_sent_by ON admin_invites(sent_by);

CREATE TABLE admin_impersonation_logs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  actions_taken INTEGER DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX idx_admin_impersonation_admin ON admin_impersonation_logs(admin_user_id);
CREATE INDEX idx_admin_impersonation_target ON admin_impersonation_logs(target_user_id);

-- ============================================================================
-- AUDIT (7 tables)
-- ============================================================================

CREATE TABLE "audit_logs" (
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

CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);

CREATE TABLE auth_audit_logs (
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

CREATE INDEX idx_auth_audit_email ON auth_audit_logs(email, timestamp DESC);
CREATE INDEX idx_auth_audit_event ON auth_audit_logs(event_type);
CREATE INDEX idx_auth_audit_event_type ON auth_audit_logs(event_type, timestamp DESC);
CREATE INDEX idx_auth_audit_failures ON auth_audit_logs(success, timestamp DESC) WHERE success = 0;
CREATE INDEX idx_auth_audit_success ON auth_audit_logs(success);
CREATE INDEX idx_auth_audit_timestamp ON auth_audit_logs(timestamp);
CREATE INDEX idx_auth_audit_user ON auth_audit_logs(user_id);

CREATE TABLE config_audit_logs (
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

CREATE INDEX idx_config_audit_action ON config_audit_logs(action, timestamp DESC);
CREATE INDEX idx_config_audit_org ON config_audit_logs(organization_id);
CREATE INDEX idx_config_audit_timestamp ON config_audit_logs(timestamp);
CREATE INDEX idx_config_audit_type ON config_audit_logs(config_type, timestamp DESC);
CREATE INDEX idx_config_audit_user ON config_audit_logs(user_id);

CREATE TABLE data_access_logs (
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

CREATE INDEX idx_data_access_org ON data_access_logs(organization_id);
CREATE INDEX idx_data_access_pii ON data_access_logs(contains_pii);
CREATE INDEX idx_data_access_source ON data_access_logs(data_source, timestamp DESC);
CREATE INDEX idx_data_access_timestamp ON data_access_logs(timestamp);
CREATE INDEX idx_data_access_user ON data_access_logs(user_id);

CREATE TABLE security_events (
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

CREATE INDEX idx_security_events_review ON security_events(manual_review_required);
CREATE INDEX idx_security_events_severity ON security_events(severity);
CREATE INDEX idx_security_events_timestamp ON security_events(timestamp);
CREATE INDEX idx_security_events_type ON security_events(event_type, timestamp DESC);

CREATE TABLE audit_retention_policy (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  table_name TEXT NOT NULL UNIQUE,
  retention_days INTEGER NOT NULL,
  last_cleanup TEXT,
  records_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE cleanup_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_type TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  records_processed INTEGER DEFAULT 0,
  records_deleted INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  error_message TEXT
);

CREATE INDEX idx_cleanup_jobs_type ON cleanup_jobs(job_type, started_at DESC);

-- ============================================================================
-- AI ENGINE (from AI_DB) (9 tables)
-- ============================================================================

CREATE TABLE ai_decisions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  platform TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  current_state TEXT DEFAULT '{}',
  reason TEXT NOT NULL,
  predicted_impact REAL,
  confidence TEXT NOT NULL DEFAULT 'medium',
  supporting_data TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  executed_at TEXT,
  execution_result TEXT,
  error_message TEXT,
  actual_impact REAL,
  measured_at TEXT
);

CREATE INDEX idx_decisions_org_pending ON ai_decisions(organization_id, status, expires_at)
  WHERE status = 'pending';
CREATE INDEX idx_decisions_org_status ON ai_decisions(organization_id, status, created_at DESC);
CREATE INDEX idx_decisions_entity ON ai_decisions(platform, entity_id);

CREATE TABLE ai_tool_registry (
  tool TEXT NOT NULL,
  platform TEXT NOT NULL,
  entity_types TEXT NOT NULL DEFAULT '[]',
  parameter_schema TEXT NOT NULL DEFAULT '{}',
  constraints TEXT NOT NULL DEFAULT '{}',
  api_endpoint TEXT,
  is_enabled INTEGER DEFAULT 1,
  PRIMARY KEY (tool, platform)
);

INSERT INTO ai_tool_registry (tool, platform, entity_types, constraints, api_endpoint) VALUES
  ('set_budget', 'facebook', '["campaign","ad_set"]', '{"max_change_percent":50,"min_cents":100}', '/v1/analytics/facebook/{entity_type}s/{entity_id}/budget'),
  ('set_budget', 'google', '["campaign"]', '{"max_change_percent":50}', '/v1/analytics/google/campaigns/{entity_id}/budget'),
  ('set_budget', 'tiktok', '["campaign","ad_group"]', '{"max_change_percent":50,"min_cents":2000}', '/v1/analytics/tiktok/{entity_type}s/{entity_id}/budget'),
  ('set_status', 'facebook', '["campaign","ad_set","ad"]', '{}', '/v1/analytics/facebook/{entity_type}s/{entity_id}/status'),
  ('set_status', 'google', '["campaign","ad_group","ad"]', '{}', '/v1/analytics/google/{entity_type}s/{entity_id}/status'),
  ('set_status', 'tiktok', '["campaign","ad_group","ad"]', '{}', '/v1/analytics/tiktok/{entity_type}s/{entity_id}/status'),
  ('set_age_range', 'facebook', '["ad_set"]', '{"min":18,"max":65}', '/v1/analytics/facebook/ad-sets/{entity_id}/targeting');

CREATE TABLE ai_org_configs (
  organization_id TEXT PRIMARY KEY,
  is_enabled INTEGER DEFAULT 1,
  auto_execute INTEGER DEFAULT 0,
  min_confidence TEXT DEFAULT 'medium',
  decision_ttl_days INTEGER DEFAULT 7,
  max_daily_decisions INTEGER DEFAULT 20,
  max_auto_budget_change_pct INTEGER DEFAULT 20,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE analysis_prompts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT UNIQUE NOT NULL,
  level TEXT NOT NULL,
  platform TEXT,
  template TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);

CREATE INDEX idx_prompts_level ON analysis_prompts(level);
CREATE INDEX idx_prompts_platform ON analysis_prompts(platform) WHERE platform IS NOT NULL;

CREATE TABLE analysis_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  level TEXT NOT NULL,
  platform TEXT,
  entity_id TEXT,
  entity_name TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  prompt TEXT,
  response TEXT,
  analysis_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_logs_org_created ON analysis_logs(organization_id, created_at DESC);
CREATE INDEX idx_logs_org_level_entity ON analysis_logs(organization_id, level, entity_id);
CREATE INDEX idx_logs_run ON analysis_logs(analysis_run_id) WHERE analysis_run_id IS NOT NULL;

CREATE TABLE analysis_summaries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  level TEXT NOT NULL,
  platform TEXT,
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  summary TEXT NOT NULL,
  metrics_snapshot TEXT DEFAULT '{}',
  days INTEGER NOT NULL,
  analysis_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_summaries_org_level_entity ON analysis_summaries(organization_id, level, entity_id, created_at DESC);
CREATE INDEX idx_summaries_org_run ON analysis_summaries(organization_id, analysis_run_id);
CREATE UNIQUE INDEX idx_summaries_unique ON analysis_summaries(organization_id, level, platform, entity_id, analysis_run_id);

CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  days INTEGER NOT NULL,
  webhook_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_entities INTEGER,
  processed_entities INTEGER DEFAULT 0,
  current_level TEXT,
  analysis_run_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  stopped_reason TEXT,
  termination_reason TEXT
);

CREATE INDEX idx_jobs_org_created ON analysis_jobs(organization_id, created_at DESC);
CREATE INDEX idx_jobs_org_status ON analysis_jobs(organization_id, status);
CREATE INDEX idx_jobs_status_created ON analysis_jobs(status, created_at) WHERE status IN ('pending', 'running');

CREATE TABLE cac_predictions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  predicted_cac_cents INTEGER NOT NULL,
  predicted_cac_lower_cents INTEGER,
  predicted_cac_upper_cents INTEGER,
  recommendation_ids TEXT DEFAULT '[]',
  analysis_run_id TEXT,
  assumptions TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(organization_id, prediction_date)
);

CREATE INDEX idx_cac_predictions_org_date ON cac_predictions(organization_id, prediction_date DESC);

CREATE TABLE cac_baselines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  baseline_date TEXT NOT NULL,
  actual_cac_cents INTEGER NOT NULL,
  baseline_cac_cents INTEGER NOT NULL,
  calculation_method TEXT NOT NULL DEFAULT 'trend_extrapolation',
  calculation_data TEXT DEFAULT '{}',
  active_recommendations TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(organization_id, baseline_date)
);

CREATE INDEX idx_cac_baselines_org_date ON cac_baselines(organization_id, baseline_date DESC);

-- ============================================================================
-- EXTRA TABLES (global events watermark)
-- ============================================================================

CREATE TABLE global_events_watermark (
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
