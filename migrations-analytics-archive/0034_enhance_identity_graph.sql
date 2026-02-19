-- ============================================================================
-- MIGRATION 0034: Enhance Identity Graph
-- ============================================================================
-- Part of: Infrastructure Phase 3 - Identity Graph
--
-- Adds:
-- - phone_hash for phone-based identity matching
-- - canonical_user_id for merged identities
-- - CRM external IDs (HubSpot, Salesforce, Jobber)
-- - Identity merge tracking
-- - Link events audit trail
-- ============================================================================

-- =============================================================================
-- ADD NEW COLUMNS TO CUSTOMER_IDENTITIES
-- =============================================================================

-- Phone hash for phone-based identity matching
ALTER TABLE customer_identities ADD COLUMN phone_hash TEXT;

-- Canonical user ID - points to the primary identity after merge
ALTER TABLE customer_identities ADD COLUMN canonical_user_id TEXT;

-- CRM external IDs
ALTER TABLE customer_identities ADD COLUMN hubspot_contact_id TEXT;
ALTER TABLE customer_identities ADD COLUMN salesforce_contact_id TEXT;
ALTER TABLE customer_identities ADD COLUMN jobber_client_id TEXT;

-- Identity merge tracking
ALTER TABLE customer_identities ADD COLUMN merged_into_id TEXT;
ALTER TABLE customer_identities ADD COLUMN merged_at TEXT;
ALTER TABLE customer_identities ADD COLUMN is_canonical INTEGER DEFAULT 1;

-- =============================================================================
-- NEW INDEXES
-- =============================================================================

-- Phone hash index for phone-based lookups
CREATE INDEX IF NOT EXISTS idx_ci_phone_hash
  ON customer_identities(organization_id, phone_hash)
  WHERE phone_hash IS NOT NULL;

-- Canonical user ID for finding all identities of a user
CREATE INDEX IF NOT EXISTS idx_ci_canonical
  ON customer_identities(canonical_user_id)
  WHERE canonical_user_id IS NOT NULL;

-- CRM ID indexes
CREATE INDEX IF NOT EXISTS idx_ci_hubspot
  ON customer_identities(hubspot_contact_id)
  WHERE hubspot_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ci_salesforce
  ON customer_identities(salesforce_contact_id)
  WHERE salesforce_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ci_jobber
  ON customer_identities(jobber_client_id)
  WHERE jobber_client_id IS NOT NULL;

-- Merged identity lookup
CREATE INDEX IF NOT EXISTS idx_ci_merged_into
  ON customer_identities(merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- =============================================================================
-- IDENTITY LINK EVENTS TABLE (AUDIT TRAIL)
-- =============================================================================
-- Tracks how identities are linked/merged over time for debugging and analytics.

CREATE TABLE IF NOT EXISTS identity_link_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- The identity being linked/updated
  source_identity_id TEXT NOT NULL,
  -- The target identity (if merging) or null (if just adding a link)
  target_identity_id TEXT,

  -- Type of link event
  link_type TEXT NOT NULL,  -- 'email_match', 'phone_match', 'device_match', 'purchase_match', 'crm_match', 'manual_merge'

  -- Confidence in this link (0.0 to 1.0)
  link_confidence REAL DEFAULT 1.0,

  -- Source of this link (which system triggered it)
  link_source TEXT,  -- 'stripe_webhook', 'hubspot_sync', 'shopify_webhook', 'manual', 'tag_identify'

  -- Additional context
  link_metadata TEXT,  -- JSON with details

  created_at TEXT DEFAULT (datetime('now')),

  -- Foreign key constraint (soft - D1 doesn't enforce)
  -- source_identity_id REFERENCES customer_identities(id)
  -- target_identity_id REFERENCES customer_identities(id)

  -- Index for audit trail queries
  UNIQUE(organization_id, source_identity_id, target_identity_id, link_type, created_at)
);

-- Indexes for link events
CREATE INDEX IF NOT EXISTS idx_ile_org
  ON identity_link_events(organization_id);

CREATE INDEX IF NOT EXISTS idx_ile_source
  ON identity_link_events(source_identity_id);

CREATE INDEX IF NOT EXISTS idx_ile_target
  ON identity_link_events(target_identity_id)
  WHERE target_identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ile_type
  ON identity_link_events(link_type);

CREATE INDEX IF NOT EXISTS idx_ile_created
  ON identity_link_events(organization_id, created_at);
