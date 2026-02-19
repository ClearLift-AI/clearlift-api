-- Migration: Add Jobber connector configuration
-- Date: 2026-01-06
-- Description: Adds Jobber as a supported OAuth connector for field service management data

-- Add Jobber-specific columns to platform_connections
-- These store the Jobber account ID and company name
ALTER TABLE platform_connections ADD COLUMN jobber_account_id TEXT;
ALTER TABLE platform_connections ADD COLUMN jobber_company_name TEXT;

-- Create index for Jobber account lookups
CREATE INDEX IF NOT EXISTS idx_platform_connections_jobber_account_id
ON platform_connections(jobber_account_id)
WHERE jobber_account_id IS NOT NULL;

-- Insert Jobber into connector_configs
-- This enables Jobber as an available connector in the UI
INSERT OR REPLACE INTO connector_configs (
  id,
  provider,
  name,
  logo_url,
  auth_type,
  oauth_authorize_url,
  oauth_token_url,
  oauth_scopes,
  requires_api_key,
  is_active,
  config_schema
) VALUES (
  'jobber-001',
  'jobber',
  'Jobber',
  'https://getjobber.com/wp-content/themes/flavor/assets/images/favicon/favicon-32x32.png',
  'oauth',
  'https://api.getjobber.com/api/oauth/authorize',
  'https://api.getjobber.com/api/oauth/token',
  '["read_jobs", "read_invoices", "read_clients", "read_quotes", "read_requests"]',
  0,
  1,
  json('{
    "sync_jobs": {
      "type": "boolean",
      "default": true,
      "description": "Sync completed jobs as conversion events"
    },
    "sync_invoices": {
      "type": "boolean",
      "default": true,
      "description": "Sync paid invoices for revenue tracking"
    },
    "sync_clients": {
      "type": "boolean",
      "default": true,
      "description": "Sync client data for attribution matching"
    },
    "sync_quotes": {
      "type": "boolean",
      "default": false,
      "description": "Sync quotes for lead pipeline analysis"
    },
    "sync_requests": {
      "type": "boolean",
      "default": false,
      "description": "Sync service requests as lead events"
    },
    "lookback_days": {
      "type": "number",
      "default": 90,
      "minimum": 1,
      "maximum": 730,
      "description": "How many days of historical data to sync"
    },
    "job_status_filter": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["completed"],
      "description": "Which job statuses to include as conversions"
    }
  }')
);
