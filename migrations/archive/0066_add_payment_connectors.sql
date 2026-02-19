-- Migration number: 0066 2025-12-23T00:00:00.000Z
-- Add payment platform connector configurations (Lemon Squeezy, Paddle, Chargebee, Recurly)
-- These connectors complement Stripe for subscription/revenue tracking

-- Add Lemon Squeezy connector config
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
  'lemon_squeezy-001',
  'lemon_squeezy',
  'Lemon Squeezy',
  'https://www.lemonsqueezy.com/favicon.ico',
  'api_key',
  true,
  true,
  json('{
    "api_key": {
      "type": "string",
      "required": true,
      "description": "Lemon Squeezy API Key (from Settings → API)",
      "secret": true
    },
    "sync_orders": {
      "type": "boolean",
      "required": false,
      "description": "Sync order data",
      "default": true
    },
    "sync_subscriptions": {
      "type": "boolean",
      "required": false,
      "description": "Sync subscription data",
      "default": true
    },
    "lookback_days": {
      "type": "number",
      "required": false,
      "description": "Number of days to sync historical data",
      "default": 90,
      "minimum": 1,
      "maximum": 730
    }
  }')
);

-- Add Paddle connector config
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
  'paddle-001',
  'paddle',
  'Paddle',
  'https://paddle.com/favicon.ico',
  'api_key',
  true,
  true,
  json('{
    "api_key": {
      "type": "string",
      "required": true,
      "description": "Paddle API Key (pdl_live_* or pdl_sdbx_*)",
      "secret": true
    },
    "environment": {
      "type": "string",
      "required": false,
      "description": "Paddle environment (live or sandbox)",
      "default": "live",
      "enum": ["live", "sandbox"]
    },
    "sync_transactions": {
      "type": "boolean",
      "required": false,
      "description": "Sync transaction data",
      "default": true
    },
    "sync_subscriptions": {
      "type": "boolean",
      "required": false,
      "description": "Sync subscription data",
      "default": true
    },
    "lookback_days": {
      "type": "number",
      "required": false,
      "description": "Number of days to sync historical data",
      "default": 90,
      "minimum": 1,
      "maximum": 730
    }
  }')
);

-- Add Chargebee connector config
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
  'chargebee-001',
  'chargebee',
  'Chargebee',
  'https://www.chargebee.com/favicon.ico',
  'api_key',
  true,
  true,
  json('{
    "api_key": {
      "type": "string",
      "required": true,
      "description": "Chargebee API Key",
      "secret": true
    },
    "site": {
      "type": "string",
      "required": true,
      "description": "Chargebee site name (e.g., mycompany for mycompany.chargebee.com)"
    },
    "sync_invoices": {
      "type": "boolean",
      "required": false,
      "description": "Sync invoice data",
      "default": true
    },
    "sync_subscriptions": {
      "type": "boolean",
      "required": false,
      "description": "Sync subscription data",
      "default": true
    },
    "lookback_days": {
      "type": "number",
      "required": false,
      "description": "Number of days to sync historical data",
      "default": 90,
      "minimum": 1,
      "maximum": 730
    }
  }')
);

-- Add Recurly connector config
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
  'recurly-001',
  'recurly',
  'Recurly',
  'https://recurly.com/favicon.ico',
  'api_key',
  true,
  true,
  json('{
    "api_key": {
      "type": "string",
      "required": true,
      "description": "Recurly Private API Key",
      "secret": true
    },
    "sync_invoices": {
      "type": "boolean",
      "required": false,
      "description": "Sync invoice data",
      "default": true
    },
    "sync_subscriptions": {
      "type": "boolean",
      "required": false,
      "description": "Sync subscription data",
      "default": true
    },
    "lookback_days": {
      "type": "number",
      "required": false,
      "description": "Number of days to sync historical data",
      "default": 90,
      "minimum": 1,
      "maximum": 730
    }
  }')
);
