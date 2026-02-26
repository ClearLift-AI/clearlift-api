-- Grouped migration: tag_tracking
-- Tables: org_tag_mappings, org_tracking_configs, tracking_domains, tracking_links, script_hashes, consent_configurations

-- Table: org_tag_mappings
CREATE TABLE org_tag_mappings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  short_tag TEXT UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Indexes for org_tag_mappings
CREATE INDEX idx_org_tag_mappings_active ON org_tag_mappings(is_active);
CREATE INDEX idx_org_tag_mappings_organization_id ON org_tag_mappings(organization_id);
CREATE INDEX idx_org_tag_mappings_short_tag ON org_tag_mappings(short_tag);

-- Table: org_tracking_configs
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

-- Indexes for org_tracking_configs
CREATE INDEX idx_org_tracking_configs_org_id ON org_tracking_configs(organization_id);
CREATE INDEX idx_org_tracking_configs_snippet_complexity ON org_tracking_configs(snippet_complexity);

-- Triggers for org_tracking_configs
CREATE TRIGGER update_org_tracking_configs_timestamp
    AFTER UPDATE ON org_tracking_configs
    FOR EACH ROW
BEGIN
    UPDATE org_tracking_configs
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

-- Table: tracking_domains
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

-- Indexes for tracking_domains
CREATE INDEX idx_tracking_domains_domain ON tracking_domains(domain);
CREATE INDEX idx_tracking_domains_org_id ON tracking_domains(organization_id);

-- Triggers for tracking_domains
CREATE TRIGGER update_tracking_domains_timestamp
    AFTER UPDATE ON tracking_domains
    FOR EACH ROW
BEGIN
    UPDATE tracking_domains
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

-- Table: tracking_links
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

-- Indexes for tracking_links
CREATE INDEX idx_tracking_links_campaign ON tracking_links(org_tag, utm_campaign);
CREATE INDEX idx_tracking_links_id_active ON tracking_links(id, is_active);
CREATE INDEX idx_tracking_links_org ON tracking_links(org_tag, created_at DESC);

-- Table: script_hashes
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

-- Indexes for script_hashes
CREATE INDEX idx_script_hashes_hash ON script_hashes(hash);

-- Triggers for script_hashes
CREATE TRIGGER update_script_hashes_timestamp
    AFTER UPDATE ON script_hashes
    FOR EACH ROW
BEGIN
    UPDATE script_hashes
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

-- Table: consent_configurations
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

-- Indexes for consent_configurations
CREATE INDEX idx_consent_config_org_tag ON consent_configurations(org_tag);
