-- ============================================================================
-- MIGRATION 0014: Restore Customer Identities Table
-- ============================================================================
-- The customer_identities table was dropped in 0002_simplify_to_aggregates.sql
-- but is required for deterministic email-hash based attribution matching.
--
-- Without this table, SmartAttributionService falls back to probabilistic matching.
-- ============================================================================

CREATE TABLE IF NOT EXISTS customer_identities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  org_tag TEXT NOT NULL,

  -- Primary identifiers
  anonymous_id TEXT NOT NULL,
  user_id_hash TEXT,
  email_hash TEXT,
  device_fingerprint_id TEXT,

  -- External IDs (from revenue platforms)
  stripe_customer_id TEXT,
  shopify_customer_id TEXT,

  -- Identity confidence
  identity_method TEXT NOT NULL, -- 'anonymous', 'device_fingerprint', 'email_capture', 'login', 'signup', 'purchase'
  identity_confidence REAL DEFAULT 0.3,

  -- First touch attribution
  first_touch_source TEXT,
  first_touch_medium TEXT,
  first_touch_campaign TEXT,
  first_touch_click_id TEXT,
  first_touch_click_id_type TEXT,

  -- Timestamps
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,

  -- Aggregated metrics
  total_sessions INTEGER DEFAULT 0,
  total_touchpoints INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,

  -- Device history (JSON array)
  known_devices TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(org_tag, anonymous_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_ci_org ON customer_identities(organization_id);
CREATE INDEX IF NOT EXISTS idx_ci_org_tag ON customer_identities(org_tag);
CREATE INDEX IF NOT EXISTS idx_ci_org_user ON customer_identities(organization_id, user_id_hash) WHERE user_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_org_email ON customer_identities(organization_id, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_stripe ON customer_identities(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_shopify ON customer_identities(shopify_customer_id) WHERE shopify_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_anon ON customer_identities(anonymous_id);
