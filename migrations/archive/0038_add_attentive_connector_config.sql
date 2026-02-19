-- Migration number: 0038 2025-12-15T00:00:00.000Z
-- Add Attentive SMS Marketing connector configuration
-- Attentive data is stored in Supabase (attentive schema)

-- Add Attentive connector config
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
  'attentive-001',
  'attentive',
  'Attentive SMS',
  'https://www.attentive.com/favicon.ico',
  'api_key',
  true,
  true,
  json('{
    "api_key": {
      "type": "string",
      "required": true,
      "description": "Attentive API Key (from your Attentive app settings)",
      "secret": true
    },
    "sync_subscribers": {
      "type": "boolean",
      "required": false,
      "description": "Sync subscriber data",
      "default": true
    },
    "sync_campaigns": {
      "type": "boolean",
      "required": false,
      "description": "Sync campaign performance data",
      "default": true
    },
    "sync_messages": {
      "type": "boolean",
      "required": false,
      "description": "Sync individual message data",
      "default": false
    },
    "sync_journeys": {
      "type": "boolean",
      "required": false,
      "description": "Sync journey/automation data",
      "default": true
    },
    "sync_revenue": {
      "type": "boolean",
      "required": false,
      "description": "Sync revenue attribution data",
      "default": true
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

-- Note: All Attentive data is stored in Supabase
-- See schemas/attentive/01-complete-schema.sql for the Supabase schema
