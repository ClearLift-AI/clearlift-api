-- Migration number: 0015 2025-10-27T00:00:00.000Z
-- Migrate Stripe connector to payment_intents only (remove sync_mode)
-- Mark existing connections for reconfiguration

-- Update connector config schema (remove sync_mode option)
UPDATE connector_configs
SET config_schema = json('{
  "api_key": {
    "type": "string",
    "required": true,
    "description": "Stripe Secret Key (sk_test_ or sk_live_)",
    "pattern": "^sk_(test_|live_)[a-zA-Z0-9]{24,}$",
    "secret": true
  },
  "lookback_days": {
    "type": "number",
    "required": false,
    "description": "Days of historical data to sync (payment_intents only, succeeded status)",
    "default": 30,
    "minimum": 1,
    "maximum": 365
  },
  "auto_sync": {
    "type": "boolean",
    "required": false,
    "description": "Enable automatic syncing every 15 minutes",
    "default": true
  }
}')
WHERE provider = 'stripe';

-- Add new columns to platform_connections for migration tracking
ALTER TABLE platform_connections
  ADD COLUMN requires_reconfiguration BOOLEAN DEFAULT FALSE;

ALTER TABLE platform_connections
  ADD COLUMN migration_notice TEXT;

-- Mark all existing Stripe connections for reconfiguration
UPDATE platform_connections
SET requires_reconfiguration = TRUE,
    migration_notice = 'Stripe connector has been updated to track payment_intents with invoice line items. PII has been removed. Please reconfigure your connection. See: https://docs.clearlift.ai/stripe-migration',
    updated_at = CURRENT_TIMESTAMP
WHERE provider = 'stripe';

-- Note: This migration affects the connector configuration only.
-- Actual Stripe conversion data is stored in Supabase (managed by clearlift-cron).
-- The Supabase schema migration must be run separately on the Supabase database.
