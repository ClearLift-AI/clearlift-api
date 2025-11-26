-- Template to insert a new connector configuration
-- Replace values as needed

INSERT INTO connector_configs (
  id,
  provider,
  name,
  logo_url,
  auth_type,
  requires_api_key,
  is_active,
  config_schema
) VALUES (
  'shopify-001',           -- id: Unique identifier
  'shopify',          -- provider: e.g., 'salesforce', 'hubspot'
  'Shopify',         -- name: Display name
  'https://www.google.com/url?sa=i&url=https%3A%2F%2Fbrandslogos.com%2Fs%2Fshopify-logo%2F&psig=AOvVaw2jX4HQZ0VaV_Ig_lyTlXZE&ust=1764064823898000&source=images&cd=vfe&opi=89978449&ved=0CBUQjRxqFwoTCPibtd3DipEDFQAAAAAdAAAAABAE', -- logo_url
  'oauth2',                     -- auth_type: 'oauth2', 'api_key', or 'basic'
  0,                            -- requires_api_key: 1 (true) or 0 (false)
  1,                            -- is_active: 1 (true) or 0 (false)
  json('{
    "access_token": {
      "type": "string",
      "required": true,
      "token": ""
    }
  }')
);

-- To view the inserted record:
-- SELECT * FROM connector_configs WHERE id = 'new-connector-id';
