-- Migration number: 0010 2025-10-13T00:00:00.000Z
-- Add connector filter rules configuration (stored in D1)
-- Actual Stripe data is stored in Supabase

-- Filter rules configuration stays in D1 for fast access
CREATE TABLE IF NOT EXISTS connector_filter_rules (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT DEFAULT 'include',
  operator TEXT DEFAULT 'AND',
  conditions TEXT NOT NULL, -- JSON array of filter conditions
  is_active BOOLEAN DEFAULT TRUE,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (connection_id) REFERENCES platform_connections(id) ON DELETE CASCADE
);

-- Add Stripe-specific fields to platform_connections
-- Note: SQLite doesn't support IF NOT EXISTS for ADD COLUMN
-- These will error if columns already exist, which is expected behavior
ALTER TABLE platform_connections ADD COLUMN stripe_account_id TEXT;
ALTER TABLE platform_connections ADD COLUMN stripe_livemode BOOLEAN DEFAULT TRUE;
ALTER TABLE platform_connections ADD COLUMN filter_rules_count INTEGER DEFAULT 0;

-- Update connector_configs for Stripe if not already present
INSERT OR REPLACE INTO connector_configs (
  id,
  provider,
  name,
  logo_url,
  auth_type,
  requires_api_key,
  is_active,
  config_schema
) VALUES (
  'stripe-001',
  'stripe',
  'Stripe',
  'https://images.ctfassets.net/fzn2n1nzq965/HTTOloNPhisV9P4hlMPNA/cacf1bb88b9fc492dfad34378d844280/Stripe_icon_-_square.svg',
  'api_key',
  true,
  true,
  json('{
    "api_key": {
      "type": "string",
      "required": true,
      "description": "Stripe Secret Key (starts with sk_)",
      "pattern": "^sk_(test_|live_)[a-zA-Z0-9]{24,}$",
      "secret": true
    },
    "sync_mode": {
      "type": "string",
      "required": false,
      "description": "Sync mode for data retrieval",
      "enum": ["charges", "payment_intents", "invoices"],
      "default": "charges"
    },
    "lookback_days": {
      "type": "number",
      "required": false,
      "description": "Number of days to sync historical data",
      "default": 30,
      "minimum": 1,
      "maximum": 365
    }
  }')
);

-- Note: All Stripe revenue data is stored in Supabase
-- See supabase/migrations/stripe_tables.sql for the Supabase schema