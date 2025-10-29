-- Migration number: 0015 2025-10-27T00:00:00.000Z
-- Stripe Payment Intents Migration (Pre-Launch - Simplified)

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

-- Pre-launch: No existing connections to migrate, so skip reconfiguration fields
-- Note: This migration focuses only on the connector configuration
-- Actual Stripe conversion data is stored in Supabase (managed by clearlift-cron)
