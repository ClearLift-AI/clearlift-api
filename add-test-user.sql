-- ============================================================================
-- Add test+1761236132@clearlift.ai to test-org-001
-- ============================================================================
-- This grants the test user access to the test organization for loading test data
-- Run this against the D1 database
-- ============================================================================

-- Insert or update the test user
INSERT INTO users (
  id,
  email,
  issuer,
  access_sub,
  name,
  created_at,
  last_login_at,
  updated_at
) VALUES (
  'test-user-1761236132',
  'test+1761236132@clearlift.ai',
  'test-issuer',
  'test-access-sub-1761236132',
  'Test User',
  datetime('now'),
  datetime('now'),
  datetime('now')
)
ON CONFLICT(issuer, access_sub) DO UPDATE
  SET email = EXCLUDED.email,
      name = EXCLUDED.name,
      last_login_at = datetime('now'),
      updated_at = datetime('now');

-- Ensure test organization exists
INSERT INTO organizations (
  id,
  name,
  slug,
  subscription_tier,
  settings,
  created_at,
  updated_at
) VALUES (
  'test-org-001',
  'Test Organization',
  'test-org-001',
  'enterprise',
  '{}',
  datetime('now'),
  datetime('now')
)
ON CONFLICT(id) DO UPDATE
  SET updated_at = datetime('now');

-- Add user to organization with admin role
INSERT INTO organization_members (
  organization_id,
  user_id,
  role,
  joined_at
) VALUES (
  'test-org-001',
  'test-user-1761236132',
  'admin', -- Give admin access for testing
  datetime('now')
)
ON CONFLICT(organization_id, user_id) DO UPDATE
  SET role = 'admin';

-- Verify the setup
SELECT
  'User added successfully' as status,
  u.email,
  o.name as organization,
  om.role
FROM users u
JOIN organization_members om ON u.id = om.user_id
JOIN organizations o ON om.organization_id = o.id
WHERE u.email = 'test+1761236132@clearlift.ai'
  AND o.id = 'test-org-001';
