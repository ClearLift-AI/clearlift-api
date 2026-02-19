-- ============================================================================
-- MIGRATION: Unified CRM Tables
-- ============================================================================
-- Category-based tables for CRM integrations (HubSpot, Salesforce, Pipedrive, etc.)
-- Enables identity matching between CRM contacts and ad platform conversions.
--
-- Key design decisions:
-- - source_platform identifies the CRM source
-- - email_hash/phone_hash enable privacy-preserving identity matching
-- - properties JSON stores CRM custom fields
-- - lifecycle_stage normalized across platforms
-- - All monetary values stored in cents (INTEGER)
-- ============================================================================

-- ============================================================================
-- CRM CONTACTS
-- ============================================================================
-- Unified contact records from all CRM platforms.
-- Used for identity matching with ad conversions.

CREATE TABLE IF NOT EXISTS crm_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,       -- 'hubspot', 'salesforce', 'pipedrive', 'zoho'
  external_id TEXT NOT NULL,           -- CRM-specific contact ID
  -- Identity fields (hashed for privacy)
  email_hash TEXT,                     -- SHA256 hash for identity matching
  phone_hash TEXT,                     -- SHA256 hash for identity matching
  -- Contact info
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  job_title TEXT,
  -- Lead/lifecycle tracking
  lead_status TEXT,                    -- Platform-specific lead status
  lead_score INTEGER,                  -- Numeric lead score (0-100)
  lifecycle_stage TEXT,                -- Normalized: 'subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist'
  -- Attribution
  original_source TEXT,                -- First touch source
  original_campaign TEXT,              -- First touch campaign
  latest_source TEXT,                  -- Last touch source
  latest_campaign TEXT,                -- Last touch campaign
  -- Platform data
  properties TEXT,                     -- JSON: all custom properties from CRM
  raw_data TEXT,                       -- Full API response
  -- Timestamps
  created_at_platform TEXT,            -- When contact was created in CRM
  last_activity_at TEXT,               -- Last activity timestamp
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Primary query patterns:
-- 1. Get all contacts for an org: WHERE organization_id = ?
-- 2. Identity matching: WHERE organization_id = ? AND email_hash = ?
-- 3. Lifecycle funnel: WHERE organization_id = ? AND lifecycle_stage IN (...)
CREATE INDEX IF NOT EXISTS idx_crmc_org ON crm_contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_crmc_org_platform ON crm_contacts(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_crmc_email_hash ON crm_contacts(organization_id, email_hash);
CREATE INDEX IF NOT EXISTS idx_crmc_phone_hash ON crm_contacts(organization_id, phone_hash);
CREATE INDEX IF NOT EXISTS idx_crmc_lifecycle ON crm_contacts(organization_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_crmc_lead_status ON crm_contacts(organization_id, lead_status);

-- ============================================================================
-- CRM COMPANIES
-- ============================================================================
-- Company/Account records for B2B attribution.

CREATE TABLE IF NOT EXISTS crm_companies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,           -- CRM-specific company ID
  -- Company info
  name TEXT NOT NULL,
  domain TEXT,                         -- Company website domain
  industry TEXT,
  employee_count INTEGER,
  annual_revenue_cents INTEGER,        -- Annual revenue in cents
  -- Classification
  company_type TEXT,                   -- 'prospect', 'customer', 'partner', 'competitor'
  tier TEXT,                           -- 'enterprise', 'mid-market', 'smb'
  -- Platform data
  properties TEXT,                     -- JSON: all custom properties
  raw_data TEXT,
  -- Timestamps
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_crmco_org ON crm_companies(organization_id);
CREATE INDEX IF NOT EXISTS idx_crmco_org_platform ON crm_companies(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_crmco_domain ON crm_companies(organization_id, domain);
CREATE INDEX IF NOT EXISTS idx_crmco_type ON crm_companies(organization_id, company_type);

-- ============================================================================
-- CRM DEALS / OPPORTUNITIES
-- ============================================================================
-- Deal/Opportunity records for revenue attribution.

CREATE TABLE IF NOT EXISTS crm_deals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,           -- CRM-specific deal ID
  -- Relationships
  contact_ref TEXT,                    -- References crm_contacts.id (nullable)
  company_ref TEXT,                    -- References crm_companies.id (nullable)
  contact_external_id TEXT,            -- CRM contact ID for reference
  company_external_id TEXT,            -- CRM company ID for reference
  -- Deal info
  name TEXT NOT NULL,
  stage TEXT NOT NULL,                 -- Pipeline stage
  pipeline TEXT,                       -- Pipeline name
  -- Value
  value_cents INTEGER DEFAULT 0,       -- Deal value in cents
  currency TEXT DEFAULT 'USD',
  probability INTEGER,                 -- 0-100 win probability
  -- Dates
  close_date TEXT,                     -- Expected close date
  won_at TEXT,                         -- When deal was won
  lost_at TEXT,                        -- When deal was lost
  lost_reason TEXT,                    -- Why deal was lost
  -- Attribution
  original_source TEXT,
  original_campaign TEXT,
  -- Platform data
  properties TEXT,
  raw_data TEXT,
  -- Timestamps
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_crmd_org ON crm_deals(organization_id);
CREATE INDEX IF NOT EXISTS idx_crmd_org_platform ON crm_deals(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_crmd_contact ON crm_deals(contact_ref);
CREATE INDEX IF NOT EXISTS idx_crmd_company ON crm_deals(company_ref);
CREATE INDEX IF NOT EXISTS idx_crmd_stage ON crm_deals(organization_id, stage);
CREATE INDEX IF NOT EXISTS idx_crmd_close_date ON crm_deals(organization_id, close_date);
CREATE INDEX IF NOT EXISTS idx_crmd_won ON crm_deals(organization_id, won_at);

-- ============================================================================
-- CRM ACTIVITIES
-- ============================================================================
-- Activity/engagement records for touchpoint attribution.

CREATE TABLE IF NOT EXISTS crm_activities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,           -- CRM-specific activity ID
  -- Relationships
  entity_type TEXT NOT NULL,           -- 'contact', 'company', 'deal'
  entity_ref TEXT NOT NULL,            -- References appropriate table's id
  entity_external_id TEXT,             -- CRM entity ID for reference
  -- Activity info
  activity_type TEXT NOT NULL,         -- 'email', 'call', 'meeting', 'note', 'task', 'form_submission'
  subject TEXT,
  body TEXT,
  -- Direction/outcome
  direction TEXT,                      -- 'inbound', 'outbound'
  status TEXT,                         -- 'completed', 'scheduled', 'canceled'
  outcome TEXT,                        -- 'connected', 'voicemail', 'no_answer', etc.
  -- Timing
  duration_seconds INTEGER,
  occurred_at TEXT NOT NULL,
  -- Platform data
  properties TEXT,
  raw_data TEXT,
  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_crma_org ON crm_activities(organization_id);
CREATE INDEX IF NOT EXISTS idx_crma_entity ON crm_activities(entity_ref);
CREATE INDEX IF NOT EXISTS idx_crma_type ON crm_activities(organization_id, activity_type);
CREATE INDEX IF NOT EXISTS idx_crma_occurred ON crm_activities(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crma_entity_type ON crm_activities(organization_id, entity_type, occurred_at DESC);

-- ============================================================================
-- LIFECYCLE STAGE NORMALIZATION
-- ============================================================================
-- Each CRM has different lifecycle/stage values. This documents the normalization:
--
-- HubSpot:
--   subscriber -> 'subscriber'
--   lead -> 'lead'
--   marketingqualifiedlead -> 'mql'
--   salesqualifiedlead -> 'sql'
--   opportunity -> 'opportunity'
--   customer -> 'customer'
--   evangelist -> 'evangelist'
--
-- Salesforce (Lead Status):
--   Open -> 'lead'
--   Working -> 'lead'
--   Qualified -> 'sql'
--   Converted -> 'customer'
--
-- Salesforce (Opportunity Stage - varies by org):
--   Prospecting -> 'opportunity'
--   Qualification -> 'opportunity'
--   Closed Won -> 'customer'
--
-- Pipedrive:
--   open -> 'lead'
--   won -> 'customer'
--   lost -> (keep original, add lost_at)
--
-- ============================================================================

-- ============================================================================
-- CRM IDENTITY LINKING
-- ============================================================================
-- Links CRM contacts to ad platform conversions for attribution.

CREATE TABLE IF NOT EXISTS crm_identity_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  -- Source CRM contact
  crm_contact_ref TEXT NOT NULL,       -- References crm_contacts.id
  crm_platform TEXT NOT NULL,          -- e.g., 'hubspot'
  -- Linked identity
  identity_type TEXT NOT NULL,         -- 'email_hash', 'phone_hash', 'customer_id'
  identity_value TEXT NOT NULL,        -- The hash or ID value
  -- Link confidence
  link_method TEXT NOT NULL,           -- 'direct_match', 'email_hash', 'phone_hash', 'manual'
  confidence_score REAL DEFAULT 1.0,   -- 0.0 to 1.0
  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  verified_at TEXT,
  UNIQUE(organization_id, crm_contact_ref, identity_type, identity_value)
);

CREATE INDEX IF NOT EXISTS idx_crmil_org ON crm_identity_links(organization_id);
CREATE INDEX IF NOT EXISTS idx_crmil_contact ON crm_identity_links(crm_contact_ref);
CREATE INDEX IF NOT EXISTS idx_crmil_identity ON crm_identity_links(organization_id, identity_type, identity_value);
