-- Grouped migration: customer_identities
-- Tables: customer_identities, identity_link_events

-- Table: customer_identities
CREATE TABLE customer_identities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  org_tag TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  user_id_hash TEXT,
  email_hash TEXT,
  device_fingerprint_id TEXT,
  stripe_customer_id TEXT,
  shopify_customer_id TEXT,
  identity_method TEXT NOT NULL,
  identity_confidence REAL DEFAULT 0.3,
  first_touch_source TEXT,
  first_touch_medium TEXT,
  first_touch_campaign TEXT,
  first_touch_click_id TEXT,
  first_touch_click_id_type TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  total_sessions INTEGER DEFAULT 0,
  total_touchpoints INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  known_devices TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  phone_hash TEXT,
  canonical_user_id TEXT,
  hubspot_contact_id TEXT,
  salesforce_contact_id TEXT,
  jobber_client_id TEXT,
  merged_into_id TEXT,
  merged_at TEXT,
  is_canonical INTEGER DEFAULT 1,
  UNIQUE(org_tag, anonymous_id)
);

-- Indexes for customer_identities
CREATE INDEX idx_ci_anon ON customer_identities(anonymous_id);
CREATE INDEX idx_ci_canonical ON customer_identities(canonical_user_id) WHERE canonical_user_id IS NOT NULL;
CREATE INDEX idx_ci_hubspot ON customer_identities(hubspot_contact_id) WHERE hubspot_contact_id IS NOT NULL;
CREATE INDEX idx_ci_jobber ON customer_identities(jobber_client_id) WHERE jobber_client_id IS NOT NULL;
CREATE INDEX idx_ci_merged_into ON customer_identities(merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX idx_ci_org ON customer_identities(organization_id);
CREATE INDEX idx_ci_org_confidence ON customer_identities(organization_id, identity_confidence DESC);
CREATE INDEX idx_ci_org_email ON customer_identities(organization_id, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX idx_ci_org_method ON customer_identities(organization_id, identity_method);
CREATE INDEX idx_ci_org_tag ON customer_identities(org_tag);
CREATE INDEX idx_ci_org_tag_updated ON customer_identities(org_tag, updated_at DESC);
CREATE INDEX idx_ci_org_user ON customer_identities(organization_id, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX idx_ci_phone_hash ON customer_identities(organization_id, phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX idx_ci_salesforce ON customer_identities(salesforce_contact_id) WHERE salesforce_contact_id IS NOT NULL;
CREATE INDEX idx_ci_shopify ON customer_identities(shopify_customer_id) WHERE shopify_customer_id IS NOT NULL;
CREATE INDEX idx_ci_stripe ON customer_identities(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Table: identity_link_events
CREATE TABLE identity_link_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_identity_id TEXT NOT NULL,
  target_identity_id TEXT,
  link_type TEXT NOT NULL,
  link_confidence REAL DEFAULT 1.0,
  link_source TEXT,
  link_metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_identity_id, target_identity_id, link_type, created_at)
);

-- Indexes for identity_link_events
CREATE INDEX idx_ile_created ON identity_link_events(organization_id, created_at);
CREATE INDEX idx_ile_org ON identity_link_events(organization_id);
CREATE INDEX idx_ile_source ON identity_link_events(source_identity_id);
CREATE INDEX idx_ile_target ON identity_link_events(target_identity_id) WHERE target_identity_id IS NOT NULL;
CREATE INDEX idx_ile_type ON identity_link_events(link_type);
