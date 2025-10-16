-- Create test user
INSERT OR REPLACE INTO users (
  id,
  email,
  name,
  issuer,
  access_sub,
  created_at,
  last_login_at,
  avatar_url
) VALUES (
  'test-user-001',
  'test@clearlift.ai',
  'Test User',
  'clearlift-auth',
  'test-sub-001',
  datetime('now'),
  datetime('now'),
  'https://example.com/avatar.jpg'
);

-- Create test organization
INSERT OR REPLACE INTO organizations (
  id,
  name,
  slug,
  created_at,
  updated_at,
  settings,
  subscription_tier
) VALUES (
  'test-org-001',
  'Test Organization',
  'test-org',
  datetime('now'),
  datetime('now'),
  '{}',
  'pro'
);

-- Add user to organization
INSERT OR REPLACE INTO organization_members (
  organization_id,
  user_id,
  role,
  joined_at,
  invited_by
) VALUES (
  'test-org-001',
  'test-user-001',
  'owner',
  datetime('now'),
  NULL
);

-- Create test session
INSERT OR REPLACE INTO sessions (
  token,
  user_id,
  created_at,
  expires_at,
  ip_address,
  user_agent
) VALUES (
  '00000000-test-1234-0000-000000000000',
  'test-user-001',
  datetime('now'),
  datetime('now', '+30 days'),
  '127.0.0.1',
  'Test Agent'
);

-- Add org tag mapping for DuckDB access
INSERT OR REPLACE INTO org_tag_mappings (
  id,
  organization_id,
  short_tag,
  is_active,
  created_at,
  updated_at
) VALUES (
  'tag-001',
  'test-org-001',
  'a3f7c2',
  1,
  datetime('now'),
  datetime('now')
);

-- Add platform connection for Facebook
INSERT OR REPLACE INTO platform_connections (
  id,
  organization_id,
  platform,
  account_id,
  account_name,
  connected_by,
  connected_at,
  last_synced_at,
  sync_status,
  is_active
) VALUES (
  'test-org-001-facebook-123456',
  'test-org-001',
  'facebook',
  '123456789',
  'Test Facebook Account',
  'test-user-001',
  datetime('now'),
  datetime('now'),
  'synced',
  1
);