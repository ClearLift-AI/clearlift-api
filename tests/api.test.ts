/**
 * API Endpoint Tests (Local Worker)
 *
 * Tests cover:
 * - Health endpoint
 * - OpenAPI/Swagger functionality
 * - Core endpoint responses
 * - Authentication flow
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

/**
 * NOTE: Health endpoint tests are low-value smoke tests.
 * They verify the endpoint exists and returns expected shape,
 * but don't test meaningful business logic.
 * Kept for deployment verification purposes only.
 */
describe('Health Endpoint', () => {
  it('should return healthy status', async () => {
    const response = await SELF.fetch('http://localhost/v1/health');
    const data = await response.json() as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.status).toBe('healthy');
    expect(data.data.service).toBe('clearlift-api');
  });

  it('should include binding checks', async () => {
    const response = await SELF.fetch('http://localhost/v1/health');
    const data = await response.json() as any;

    expect(data.data.bindings).toBeDefined();
    expect(data.data.bindings.db).toBe(true);
  });

  it('should include timestamp', async () => {
    const response = await SELF.fetch('http://localhost/v1/health');
    const data = await response.json() as any;

    expect(data.data.timestamp).toBeDefined();
    // Timestamp should be a valid ISO date string
    expect(new Date(data.data.timestamp).toISOString()).toBe(data.data.timestamp);
  });
});

/**
 * NOTE: OpenAPI/Swagger tests are low-value - they test
 * auto-generated framework behavior, not application logic.
 * Kept for API documentation verification only.
 */
describe('OpenAPI/Swagger', () => {
  it('should serve OpenAPI spec at root', async () => {
    const response = await SELF.fetch('http://localhost/');
    const contentType = response.headers.get('content-type');

    expect(response.status).toBe(200);
    // Could be HTML (Swagger UI) or JSON depending on Accept header
    expect(contentType).toMatch(/html|json/);
  });

  it('should serve OpenAPI JSON schema', async () => {
    const response = await SELF.fetch('http://localhost/openapi.json');
    const data = await response.json() as any;

    expect(response.status).toBe(200);
    expect(data.openapi).toBeDefined();
    expect(data.openapi).toMatch(/^3\./); // OpenAPI 3.x
    expect(data.info).toBeDefined();
    expect(data.info.title).toBe('ClearLift API');
    expect(data.paths).toBeDefined();
  });

  it('should include all required endpoints in OpenAPI spec', async () => {
    const response = await SELF.fetch('http://localhost/openapi.json');
    const data = await response.json() as any;

    const paths = Object.keys(data.paths);

    // Health
    expect(paths).toContain('/v1/health');

    // Auth endpoints
    expect(paths).toContain('/v1/auth/login');
    expect(paths).toContain('/v1/auth/register');

    // User endpoints
    expect(paths).toContain('/v1/user/me');

    // Analytics endpoints
    expect(paths).toContain('/v1/analytics/events');
    expect(paths).toContain('/v1/analytics/conversions');
    expect(paths).toContain('/v1/analytics/attribution');
  });

  it('should include identity and journey endpoints', async () => {
    const response = await SELF.fetch('http://localhost/openapi.json');
    const data = await response.json() as any;

    const paths = Object.keys(data.paths);

    // Identity endpoints
    expect(paths).toContain('/v1/analytics/identify');
    expect(paths).toContain('/v1/analytics/identify/merge');
    expect(paths.some(p => p.includes('/identity/'))).toBe(true);

    // Journey endpoints
    expect(paths.some(p => p.includes('/journey'))).toBe(true);
    expect(paths).toContain('/v1/analytics/journeys/overview');
  });

  it('should include attribution comparison endpoint', async () => {
    const response = await SELF.fetch('http://localhost/openapi.json');
    const data = await response.json() as any;

    const paths = Object.keys(data.paths);
    expect(paths).toContain('/v1/analytics/attribution/compare');
  });

  it('should have proper security definitions', async () => {
    const response = await SELF.fetch('http://localhost/openapi.json');
    const data = await response.json() as any;

    expect(data.security).toBeDefined();
    expect(data.security.length).toBeGreaterThan(0);
  });
});

/**
 * NOTE: These tests verify auth middleware is applied,
 * which is implicit in the route definitions.
 * Low-value but kept as sanity checks.
 */
describe('Authentication Required Endpoints', () => {
  it('should return 401 for /v1/user/me without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/user/me');

    expect(response.status).toBe(401);
  });

  it('should return 401 for /v1/analytics/events without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/analytics/events');

    expect(response.status).toBe(401);
  });

  it('should return 401 for /v1/analytics/conversions without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/analytics/conversions');

    expect(response.status).toBe(401);
  });

  it('should return 401 for /v1/analytics/attribution without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/analytics/attribution?org_id=test&date_from=2024-01-01&date_to=2024-01-31');

    expect(response.status).toBe(401);
  });

  it('should return 401 for journey endpoints without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/analytics/journeys/overview?org_id=test');

    expect(response.status).toBe(401);
  });
});

describe('Public Endpoints', () => {
  it('should allow waitlist POST without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' })
    });

    // Should not be 401 (might be 200 or 400 depending on validation)
    expect(response.status).not.toBe(401);
  });

  it('should allow waitlist stats GET without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/waitlist/stats');

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.success).toBe(true);
  });

  it('should allow auth/login POST without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    });

    // Should not be 401 (might be 401 for invalid creds, but that's different from missing auth)
    // The important thing is the endpoint is reachable
    expect([200, 401, 400]).toContain(response.status);
  });

  it('should allow OAuth callback without auth', async () => {
    const response = await SELF.fetch('http://localhost/v1/connectors/google/callback?code=test');

    // Should not be 401
    expect(response.status).not.toBe(401);
  });
});

describe('CORS Headers', () => {
  it('should include CORS headers on responses', async () => {
    const response = await SELF.fetch('http://localhost/v1/health', {
      headers: {
        'Origin': 'https://app.clearlift.ai'
      }
    });

    expect(response.headers.get('access-control-allow-origin')).toBeDefined();
  });

  it('should handle OPTIONS preflight requests', async () => {
    const response = await SELF.fetch('http://localhost/v1/health', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://app.clearlift.ai',
        'Access-Control-Request-Method': 'GET'
      }
    });

    expect(response.status).toBeLessThan(400);
  });

  it('should accept staging dashboard origin', async () => {
    const response = await SELF.fetch('http://localhost/v1/health', {
      headers: { 'Origin': 'https://dev.clearlift.ai' }
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://dev.clearlift.ai');
  });

  it('should accept staging alt dashboard origin', async () => {
    const response = await SELF.fetch('http://localhost/v1/health', {
      headers: { 'Origin': 'https://app-dev.clearlift.ai' }
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app-dev.clearlift.ai');
  });

  it('should accept local tunnel origin', async () => {
    const response = await SELF.fetch('http://localhost/v1/health', {
      headers: { 'Origin': 'https://local.clearlift.ai' }
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://local.clearlift.ai');
  });

  it('should accept local tunnel dashboard origin', async () => {
    const response = await SELF.fetch('http://localhost/v1/health', {
      headers: { 'Origin': 'https://app-local.clearlift.ai' }
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app-local.clearlift.ai');
  });
});

describe('Security Headers', () => {
  it('should include security headers', async () => {
    const response = await SELF.fetch('http://localhost/v1/health');

    // Check for common security headers
    const headers = response.headers;
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('should include CSP with wildcard for clearlift subdomains', async () => {
    const response = await SELF.fetch('http://localhost/v1/health');
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBeDefined();
    if (csp) {
      expect(csp).toContain('*.clearlift.ai');
    }
  });
});

describe('Error Responses', () => {
  it('should return 404 for unknown endpoints', async () => {
    const response = await SELF.fetch('http://localhost/v1/nonexistent-endpoint');

    expect(response.status).toBe(404);
  });

  it('should return JSON error response', async () => {
    const response = await SELF.fetch('http://localhost/v1/user/me');
    const data = await response.json() as any;

    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

describe('Input Validation', () => {
  it('should validate required fields on POST endpoints', async () => {
    const response = await SELF.fetch('http://localhost/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // Missing required fields
    });

    expect(response.status).toBe(400);
  });

  it('should validate email format', async () => {
    const response = await SELF.fetch('http://localhost/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password123' })
    });

    expect(response.status).toBe(400);
  });
});

describe('Authentication Workflows', () => {
  const testPassword = 'SecurePass123!';

  // Helper to create a new user and return token
  async function createTestUser(emailPrefix: string = 'test') {
    const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const response = await SELF.fetch('http://localhost/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: testPassword,
        name: 'Test User'
      })
    });
    const data = await response.json() as any;
    return { email, token: data.data?.session?.token, response, data };
  }

  it('should register a new user and return session', async () => {
    const { response, data, email } = await createTestUser('reg');

    expect(response.status).toBe(201);
    expect(data.success).toBe(true);
    expect(data.data.user).toBeDefined();
    expect(data.data.user.email).toBe(email);
    expect(data.data.session).toBeDefined();
    expect(data.data.session.token).toBeDefined();
    expect(data.data.session.expires_at).toBeDefined();
  });

  it('should reject registration with duplicate email', async () => {
    // Create first user
    const { email } = await createTestUser('dup');

    // Try to register same email again
    const response = await SELF.fetch('http://localhost/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: testPassword,
        name: 'Test User'
      })
    });

    expect(response.status).toBe(409);

    const data = await response.json() as any;
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('USER_EXISTS');
  });

  it('should login with valid credentials', async () => {
    const { email } = await createTestUser('login');

    const response = await SELF.fetch('http://localhost/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: testPassword
      })
    });

    expect(response.status).toBe(200);

    const data = await response.json() as any;
    expect(data.success).toBe(true);
    expect(data.data.user).toBeDefined();
    expect(data.data.user.email).toBe(email);
    expect(data.data.session).toBeDefined();
    expect(data.data.session.token).toBeDefined();
  });

  it('should reject login with invalid password', async () => {
    const { email } = await createTestUser('badpw');

    const response = await SELF.fetch('http://localhost/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'WrongPassword123!'
      })
    });

    expect(response.status).toBe(401);

    const data = await response.json() as any;
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('should access protected endpoint with valid session', async () => {
    const { email, token } = await createTestUser('me');

    const response = await SELF.fetch('http://localhost/v1/user/me', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    expect(response.status).toBe(200);

    const data = await response.json() as any;
    expect(data.success).toBe(true);
    expect(data.data.user).toBeDefined();
    expect(data.data.user.email).toBe(email);
  });

  it('should logout and invalidate session', async () => {
    const { token } = await createTestUser('logout');

    // Logout
    const logoutResponse = await SELF.fetch('http://localhost/v1/auth/logout', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    expect(logoutResponse.status).toBe(200);

    // Try to use invalidated session
    const meResponse = await SELF.fetch('http://localhost/v1/user/me', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    expect(meResponse.status).toBe(401);
  });

  it('should delete account with proper confirmation', async () => {
    const { email, token } = await createTestUser('delete');

    // Delete account
    const deleteResponse = await SELF.fetch('http://localhost/v1/user/me', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        confirmation: 'DELETE'
      })
    });

    expect(deleteResponse.status).toBe(200);

    const deleteData = await deleteResponse.json() as any;
    expect(deleteData.success).toBe(true);
    expect(deleteData.data.message).toContain('deleted');

    // Verify user cannot login anymore
    const postDeleteLogin = await SELF.fetch('http://localhost/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: testPassword
      })
    });

    expect(postDeleteLogin.status).toBe(401);
  });

  it('should reject delete without proper confirmation', async () => {
    const { token } = await createTestUser('nodelete');

    // Try to delete without proper confirmation (Zod schema expects literal "DELETE")
    const deleteResponse = await SELF.fetch('http://localhost/v1/user/me', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        confirmation: 'wrong'
      })
    });

    // Should get 400 (validation error from Zod for z.literal("DELETE"))
    expect(deleteResponse.status).toBe(400);

    const deleteData = await deleteResponse.json() as any;
    expect(deleteData.success).toBe(false);
    // Zod validation errors may have different structure than our custom errors
    // The important thing is it's rejected with 400
  });
});

/**
 * Organization Access Control Tests
 *
 * These tests verify that:
 * - Users can only access organizations they belong to
 * - Cross-organization data leakage is prevented
 * - Role-based access control is enforced
 * - Removed members cannot access org data
 */
describe('Organization Access Control', () => {
  const testPassword = 'SecurePass123!';

  // Helper to create a new user with organization and return token
  async function createTestUserWithOrg(emailPrefix: string = 'org') {
    const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const orgName = `Test Org ${Date.now()}`;

    const response = await SELF.fetch('http://localhost/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: testPassword,
        name: 'Test User',
        organization_name: orgName
      })
    });
    const data = await response.json() as any;

    return {
      email,
      token: data.data?.session?.token,
      orgId: data.data?.organization?.id,
      orgSlug: data.data?.organization?.slug,
      orgName,
      userId: data.data?.user?.id,
      response,
      data
    };
  }

  describe('Cross-Organization Data Isolation', () => {
    it('should prevent User A from accessing User B org analytics', async () => {
      // Create User A with Org A
      const userA = await createTestUserWithOrg('userA');

      // Create User B with Org B
      const userB = await createTestUserWithOrg('userB');

      // User A tries to access User B's org analytics
      const response = await SELF.fetch(
        `http://localhost/v1/analytics/events?org_id=${userB.orgId}&lookback=24h`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
      const data = await response.json() as any;
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
    });

    it('should prevent User A from accessing User B org members', async () => {
      // Create User A with Org A
      const userA = await createTestUserWithOrg('userA2');

      // Create User B with Org B
      const userB = await createTestUserWithOrg('userB2');

      // User A tries to access User B's org members
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${userB.orgId}/members`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
    });

    it('should prevent User A from accessing User B org tag', async () => {
      // Create User A with Org A
      const userA = await createTestUserWithOrg('userA3');

      // Create User B with Org B
      const userB = await createTestUserWithOrg('userB3');

      // User A tries to access User B's org tag
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${userB.orgId}/tag`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
    });

    it('should prevent User A from accessing User B org connectors', async () => {
      // Create User A with Org A
      const userA = await createTestUserWithOrg('userA4');

      // Create User B with Org B
      const userB = await createTestUserWithOrg('userB4');

      // User A tries to list User B's org connectors
      const response = await SELF.fetch(
        `http://localhost/v1/connectors/connected?org_id=${userB.orgId}`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
    });

    it('should prevent User A from inviting to User B org', async () => {
      // Create User A with Org A
      const userA = await createTestUserWithOrg('userA5');

      // Create User B with Org B
      const userB = await createTestUserWithOrg('userB5');

      // User A tries to send invite to User B's org
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${userB.orgId}/invite`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${userA.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: 'victim@example.com',
            role: 'admin'
          })
        }
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Invalid Org_id Handling', () => {
    it('should reject non-existent org_id', async () => {
      const user = await createTestUserWithOrg('nonexist');

      const fakeOrgId = '00000000-0000-0000-0000-000000000000';
      const response = await SELF.fetch(
        `http://localhost/v1/analytics/events?org_id=${fakeOrgId}&lookback=24h`,
        {
          headers: { 'Authorization': `Bearer ${user.token}` }
        }
      );

      expect(response.status).toBe(403);
    });

    it('should reject invalid UUID format for org_id', async () => {
      const user = await createTestUserWithOrg('baduuid');

      const response = await SELF.fetch(
        `http://localhost/v1/analytics/events?org_id=not-a-valid-uuid&lookback=24h`,
        {
          headers: { 'Authorization': `Bearer ${user.token}` }
        }
      );

      // Should be 403 (no access) since it doesn't match any org
      expect(response.status).toBe(403);
    });

    it('should require org_id parameter for analytics endpoints', async () => {
      const user = await createTestUserWithOrg('noparam');

      // Try to access events without org_id
      const response = await SELF.fetch(
        `http://localhost/v1/analytics/events?lookback=24h`,
        {
          headers: { 'Authorization': `Bearer ${user.token}` }
        }
      );

      // Should be 400 or 403 due to missing org_id
      expect([400, 403]).toContain(response.status);
    });
  });

  describe('Role-Based Access Control', () => {
    it('should allow owner to access org data', async () => {
      const owner = await createTestUserWithOrg('owner');

      // Owner should be able to access their own org tag
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${owner.orgId}/tag`,
        {
          headers: { 'Authorization': `Bearer ${owner.token}` }
        }
      );

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.org_tag).toBeDefined();
    });

    it('should allow owner to invite members', async () => {
      const owner = await createTestUserWithOrg('ownerinv');

      const inviteEmail = `invite-${Date.now()}@example.com`;
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${owner.orgId}/invite`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${owner.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: inviteEmail,
            role: 'viewer'
          })
        }
      );

      const data = await response.json() as any;
      // In test environment, SendGrid Secrets Store binding is unavailable,
      // so the invite is created then rolled back when email fails.
      // Verify the endpoint correctly reports the email failure.
      if (response.status === 500) {
        expect(data.error.code).toBe('EMAIL_FAILED');
      } else {
        expect(response.status).toBe(201);
        expect(data.success).toBe(true);
        expect(data.data.invitation).toBeDefined();
      }
    });

    it('should allow owner to create shareable invite link', async () => {
      const owner = await createTestUserWithOrg('ownershare');

      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${owner.orgId}/invite-link`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${owner.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            role: 'viewer',
            expires_in_days: 7
          })
        }
      );

      expect(response.status).toBe(201);
      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.invite_link.invite_code).toBeDefined();
    });
  });

  describe('Organization Membership Validation', () => {
    it('should allow user to access org after creation', async () => {
      const user = await createTestUserWithOrg('neworg');

      // Should be able to get org members
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${user.orgId}/members`,
        {
          headers: { 'Authorization': `Bearer ${user.token}` }
        }
      );

      expect(response.status).toBe(200);
      const data = await response.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.members).toBeDefined();
      expect(data.data.members.length).toBeGreaterThan(0);
      expect(data.data.members[0].email).toBe(user.email);
    });

    it('should include user as owner role in their created org', async () => {
      const user = await createTestUserWithOrg('ownerrole');

      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${user.orgId}/members`,
        {
          headers: { 'Authorization': `Bearer ${user.token}` }
        }
      );

      const data = await response.json() as any;
      const userMember = data.data.members.find((m: any) => m.email === user.email);

      expect(userMember).toBeDefined();
      expect(userMember.role).toBe('owner');
    });
  });

  describe('Org Slug Resolution', () => {
    it('should allow access via org slug instead of UUID', async () => {
      const user = await createTestUserWithOrg('slugtest');

      // Get the slug from the org creation response
      const slug = user.orgSlug;

      // Access org members using slug
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${slug}/members`,
        {
          headers: { 'Authorization': `Bearer ${user.token}` }
        }
      );

      expect(response.status).toBe(200);
    });

    it('should reject access to non-member org via slug', async () => {
      const userA = await createTestUserWithOrg('slugA');
      const userB = await createTestUserWithOrg('slugB');

      // User A tries to access User B's org via slug
      const response = await SELF.fetch(
        `http://localhost/v1/organizations/${userB.orgSlug}/members`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
    });
  });

  describe('Platform Analytics Org Isolation', () => {
    it('should reject cross-org access for unified platform data', async () => {
      const userA = await createTestUserWithOrg('platA');
      const userB = await createTestUserWithOrg('platB');

      const response = await SELF.fetch(
        `http://localhost/v1/analytics/platforms/unified?org_id=${userB.orgId}`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
    });

    it('should reject cross-org access for conversions', async () => {
      const userA = await createTestUserWithOrg('convA');
      const userB = await createTestUserWithOrg('convB');

      const response = await SELF.fetch(
        `http://localhost/v1/analytics/conversions?org_id=${userB.orgId}&date_from=2024-01-01&date_to=2024-12-31`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
    });

    it('should reject cross-org access for attribution', async () => {
      const userA = await createTestUserWithOrg('attrA');
      const userB = await createTestUserWithOrg('attrB');

      const response = await SELF.fetch(
        `http://localhost/v1/analytics/attribution?org_id=${userB.orgId}&date_from=2024-01-01&date_to=2024-12-31`,
        {
          headers: { 'Authorization': `Bearer ${userA.token}` }
        }
      );

      expect(response.status).toBe(403);
    });
  });
});
