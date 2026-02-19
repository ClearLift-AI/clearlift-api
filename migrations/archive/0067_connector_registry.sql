-- Migration number: 0067 2026-01-25T00:00:00.000Z
-- Extend connector_configs table with registry fields for database-driven connector configuration
-- This enables adding new connectors with only a database row and connector implementation

-- Connector type classification (determines sync behavior and UI grouping)
-- Supports 16+ connector types for unified architecture
-- Types: ad_platform, crm, communication, ecommerce, payments, support, scheduling,
--        forms, events, analytics, accounting, attribution, reviews, affiliate, social, field_service
-- Legacy: revenue (mapped to payments), email (mapped to communication), sms (mapped to communication)
ALTER TABLE connector_configs ADD COLUMN connector_type TEXT
  CHECK (connector_type IN ('ad_platform', 'crm', 'communication', 'ecommerce', 'payments', 'support', 'scheduling', 'forms', 'events', 'analytics', 'accounting', 'attribution', 'reviews', 'affiliate', 'social', 'field_service', 'revenue', 'email', 'sms'))
  DEFAULT 'payments';

-- Category for UI grouping in dashboard
-- Categories: advertising, sales, marketing, commerce, operations, analytics, finance, communication, field_service
-- Legacy: payments, ecommerce, crm (kept for backward compatibility)
ALTER TABLE connector_configs ADD COLUMN category TEXT
  CHECK (category IN ('advertising', 'sales', 'marketing', 'commerce', 'operations', 'analytics', 'finance', 'communication', 'field_service', 'payments', 'ecommerce', 'crm'))
  DEFAULT 'commerce';

-- Display configuration
ALTER TABLE connector_configs ADD COLUMN description TEXT;
ALTER TABLE connector_configs ADD COLUMN documentation_url TEXT;
ALTER TABLE connector_configs ADD COLUMN icon_name TEXT; -- Lucide icon name or SimpleIcons key
ALTER TABLE connector_configs ADD COLUMN icon_color TEXT DEFAULT '#6B7280';
ALTER TABLE connector_configs ADD COLUMN sort_order INTEGER DEFAULT 100;

-- Feature flags
ALTER TABLE connector_configs ADD COLUMN supports_sync BOOLEAN DEFAULT TRUE;
ALTER TABLE connector_configs ADD COLUMN supports_realtime BOOLEAN DEFAULT FALSE;
ALTER TABLE connector_configs ADD COLUMN supports_webhooks BOOLEAN DEFAULT FALSE;
ALTER TABLE connector_configs ADD COLUMN is_beta BOOLEAN DEFAULT FALSE;

-- Events schema for Flow Builder (JSON array of ConnectorEvent objects)
-- Format: [{"id": "event_id", "name": "Event Name", "fields": ["field1", "field2"]}]
ALTER TABLE connector_configs ADD COLUMN events_schema TEXT;

-- Sync configuration defaults
ALTER TABLE connector_configs ADD COLUMN default_concurrency INTEGER DEFAULT 2;
ALTER TABLE connector_configs ADD COLUMN rate_limit_per_hour INTEGER;
ALTER TABLE connector_configs ADD COLUMN default_lookback_days INTEGER DEFAULT 90;
ALTER TABLE connector_configs ADD COLUMN default_sync_interval_hours INTEGER DEFAULT 24;

-- UI theming for platform cards
ALTER TABLE connector_configs ADD COLUMN theme_bg_color TEXT;
ALTER TABLE connector_configs ADD COLUMN theme_border_color TEXT;
ALTER TABLE connector_configs ADD COLUMN theme_text_color TEXT;

-- Whether this connector has an actual monetary value field
ALTER TABLE connector_configs ADD COLUMN has_actual_value BOOLEAN DEFAULT FALSE;
ALTER TABLE connector_configs ADD COLUMN value_field TEXT; -- Field name for monetary value (e.g., 'conversion_value', 'total_price_cents')

-- Required permissions description for OAuth scopes explanation
ALTER TABLE connector_configs ADD COLUMN permissions_description TEXT;

-- Platform ID mapping (for connectors where provider != platform_id in connections)
-- e.g., 'facebook' provider maps to 'facebook' or 'meta' or 'facebook_ads' platform
ALTER TABLE connector_configs ADD COLUMN platform_id TEXT;

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_connector_configs_type ON connector_configs(connector_type);
CREATE INDEX IF NOT EXISTS idx_connector_configs_category ON connector_configs(category);
CREATE INDEX IF NOT EXISTS idx_connector_configs_active ON connector_configs(is_active, connector_type);
CREATE INDEX IF NOT EXISTS idx_connector_configs_platform_id ON connector_configs(platform_id);
