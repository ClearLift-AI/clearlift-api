-- Grouped migration: connector_configs
-- Tables: connector_configs, connector_filter_rules

-- Table: connector_configs
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

-- Indexes for connector_configs
CREATE INDEX idx_connector_configs_active ON connector_configs(is_active, connector_type);
CREATE INDEX idx_connector_configs_category ON connector_configs(category);
CREATE INDEX idx_connector_configs_platform_id ON connector_configs(platform_id);
CREATE INDEX idx_connector_configs_type ON connector_configs(connector_type);

-- Table: connector_filter_rules
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
