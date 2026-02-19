-- Migration: Add Shopify connector configuration
-- Date: 2025-12-22
-- Description: Adds Shopify as a supported OAuth connector with shop-specific fields

-- Add Shopify-specific columns to platform_connections
-- These store the shop domain and Shopify's internal shop ID
ALTER TABLE platform_connections ADD COLUMN shopify_shop_domain TEXT;
ALTER TABLE platform_connections ADD COLUMN shopify_shop_id TEXT;

-- Create index for shop domain lookups
CREATE INDEX IF NOT EXISTS idx_platform_connections_shopify_shop_domain
ON platform_connections(shopify_shop_domain)
WHERE shopify_shop_domain IS NOT NULL;

-- Insert Shopify into connector_configs
-- This enables Shopify as an available connector in the UI
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
  'shopify-001',
  'shopify',
  'Shopify',
  'https://cdn.shopify.com/s/files/1/0614/3339/3912/files/shopify-logo.svg',
  'oauth',
  'https://{shop}/admin/oauth/authorize',
  'https://{shop}/admin/oauth/access_token',
  '["read_orders", "read_customers"]',
  0,
  1,
  json('{
    "shop_domain": {
      "type": "string",
      "required": true,
      "description": "Shopify store domain (e.g., my-store.myshopify.com)",
      "pattern": "^[a-zA-Z0-9][a-zA-Z0-9\\\\-]*\\\\.myshopify\\\\.com$"
    },
    "sync_mode": {
      "type": "string",
      "enum": ["orders", "orders_and_customers"],
      "default": "orders_and_customers",
      "description": "What data to sync from Shopify"
    },
    "lookback_days": {
      "type": "number",
      "default": 60,
      "minimum": 1,
      "maximum": 730,
      "description": "How many days of historical data to sync"
    }
  }')
);
