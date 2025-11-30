-- Template to insert a new connector configuration
-- Replace values as needed

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
  'shopify-001',           
  'shopify',         
  'Shopify',        
  'https://www.google.com/url?sa=i&url=https%3A%2F%2Fbrandslogos.com%2Fs%2Fshopify-logo%2F&psig=AOvVaw2jX4HQZ0VaV_Ig_lyTlXZE&ust=1764064823898000&source=images&cd=vfe&opi=89978449&ved=0CBUQjRxqFwoTCPibtd3DipEDFQAAAAAdAAAAABAE', -- logo_url
  'oauth2',                    
  0,                           
  1,                           
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
