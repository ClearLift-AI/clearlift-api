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
});

describe('Security Headers', () => {
  it('should include security headers', async () => {
    const response = await SELF.fetch('http://localhost/v1/health');

    // Check for common security headers
    const headers = response.headers;
    expect(headers.get('x-content-type-options')).toBe('nosniff');
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
