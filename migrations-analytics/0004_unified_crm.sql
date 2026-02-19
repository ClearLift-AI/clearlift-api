-- Grouped migration: unified_crm
-- Tables: crm_contacts, crm_companies, crm_deals, crm_activities, crm_identity_links

-- Table: crm_contacts
CREATE TABLE crm_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  phone_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  job_title TEXT,
  lead_status TEXT,
  lead_score INTEGER,
  lifecycle_stage TEXT,
  original_source TEXT,
  original_campaign TEXT,
  latest_source TEXT,
  latest_campaign TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_activity_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for crm_contacts
CREATE INDEX idx_crmc_email_hash ON crm_contacts(organization_id, email_hash);
CREATE INDEX idx_crmc_lead_status ON crm_contacts(organization_id, lead_status);
CREATE INDEX idx_crmc_lifecycle ON crm_contacts(organization_id, lifecycle_stage);
CREATE INDEX idx_crmc_org ON crm_contacts(organization_id);
CREATE INDEX idx_crmc_org_platform ON crm_contacts(organization_id, source_platform);
CREATE INDEX idx_crmc_phone_hash ON crm_contacts(organization_id, phone_hash);

-- Table: crm_companies
CREATE TABLE crm_companies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  industry TEXT,
  employee_count INTEGER,
  annual_revenue_cents INTEGER,
  company_type TEXT,
  tier TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for crm_companies
CREATE INDEX idx_crmco_domain ON crm_companies(organization_id, domain);
CREATE INDEX idx_crmco_org ON crm_companies(organization_id);
CREATE INDEX idx_crmco_org_platform ON crm_companies(organization_id, source_platform);
CREATE INDEX idx_crmco_type ON crm_companies(organization_id, company_type);

-- Table: crm_deals
CREATE TABLE crm_deals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  contact_ref TEXT,
  company_ref TEXT,
  contact_external_id TEXT,
  company_external_id TEXT,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,
  pipeline TEXT,
  value_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  probability INTEGER,
  close_date TEXT,
  won_at TEXT,
  lost_at TEXT,
  lost_reason TEXT,
  original_source TEXT,
  original_campaign TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for crm_deals
CREATE INDEX idx_crmd_close_date ON crm_deals(organization_id, close_date);
CREATE INDEX idx_crmd_company ON crm_deals(company_ref);
CREATE INDEX idx_crmd_contact ON crm_deals(contact_ref);
CREATE INDEX idx_crmd_org ON crm_deals(organization_id);
CREATE INDEX idx_crmd_org_platform ON crm_deals(organization_id, source_platform);
CREATE INDEX idx_crmd_stage ON crm_deals(organization_id, stage);
CREATE INDEX idx_crmd_won ON crm_deals(organization_id, won_at);

-- Table: crm_activities
CREATE TABLE crm_activities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_ref TEXT NOT NULL,
  entity_external_id TEXT,
  activity_type TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  direction TEXT,
  status TEXT,
  outcome TEXT,
  duration_seconds INTEGER,
  occurred_at TEXT NOT NULL,
  properties TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for crm_activities
CREATE INDEX idx_crma_entity ON crm_activities(entity_ref);
CREATE INDEX idx_crma_entity_type ON crm_activities(organization_id, entity_type, occurred_at DESC);
CREATE INDEX idx_crma_occurred ON crm_activities(organization_id, occurred_at DESC);
CREATE INDEX idx_crma_org ON crm_activities(organization_id);
CREATE INDEX idx_crma_type ON crm_activities(organization_id, activity_type);

-- Table: crm_identity_links
CREATE TABLE crm_identity_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  crm_contact_ref TEXT NOT NULL,
  crm_platform TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  link_method TEXT NOT NULL,
  confidence_score REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  verified_at TEXT,
  UNIQUE(organization_id, crm_contact_ref, identity_type, identity_value)
);

-- Indexes for crm_identity_links
CREATE INDEX idx_crmil_contact ON crm_identity_links(crm_contact_ref);
CREATE INDEX idx_crmil_identity ON crm_identity_links(organization_id, identity_type, identity_value);
CREATE INDEX idx_crmil_org ON crm_identity_links(organization_id);
