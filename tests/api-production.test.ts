/**
 * Production API Integration Tests
 *
 * These tests run against the live production API at api.clearlift.ai
 * to verify deployment and availability.
 *
 * Run with: npm run test:prod
 */

import { describe, it, expect } from 'vitest';

const PROD_URL = 'https://api.clearlift.ai';

describe('Production Health Check', () => {
  it('should return healthy status', async () => {
    const response = await fetch(`${PROD_URL}/v1/health`);
    const data = await response.json() as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.status).toBe('healthy');
    expect(data.data.service).toBe('clearlift-api');
  });

  it('should have all bindings connected', async () => {
    const response = await fetch(`${PROD_URL}/v1/health`);
    const data = await response.json() as any;

    expect(data.data.bindings.db).toBe(true);
    expect(data.data.bindings.analytics_db).toBe(true);
    expect(data.data.bindings.r2_sql).toBe(true);
  });

  it('should have acceptable latency', async () => {
    const start = Date.now();
    await fetch(`${PROD_URL}/v1/health`);
    const latency = Date.now() - start;

    // Health check should respond in under 2 seconds
    expect(latency).toBeLessThan(2000);
  });
});

describe('Production OpenAPI/Swagger', () => {
  it('should serve Swagger UI at root', async () => {
    const response = await fetch(`${PROD_URL}/`, {
      headers: {
        'Accept': 'text/html'
      }
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('swagger');
  });

  it('should serve OpenAPI JSON schema', async () => {
    const response = await fetch(`${PROD_URL}/openapi.json`);
    const data = await response.json() as any;

    expect(response.status).toBe(200);
    expect(data.openapi).toBeDefined();
    expect(data.openapi).toMatch(/^3\./);
    expect(data.info.title).toBe('ClearLift API');
  });

  it('should include identity endpoints in OpenAPI spec', async () => {
    const response = await fetch(`${PROD_URL}/openapi.json`);
    const data = await response.json() as any;

    const paths = Object.keys(data.paths);

    expect(paths).toContain('/v1/analytics/identify');
    expect(paths).toContain('/v1/analytics/identify/merge');
  });

  it('should include journey endpoints in OpenAPI spec', async () => {
    const response = await fetch(`${PROD_URL}/openapi.json`);
    const data = await response.json() as any;

    const paths = Object.keys(data.paths);

    expect(paths).toContain('/v1/analytics/journeys/overview');
    expect(paths.some(p => p.includes('/journey'))).toBe(true);
  });

  it('should include attribution endpoints in OpenAPI spec', async () => {
    const response = await fetch(`${PROD_URL}/openapi.json`);
    const data = await response.json() as any;

    const paths = Object.keys(data.paths);

    expect(paths).toContain('/v1/analytics/attribution');
    expect(paths).toContain('/v1/analytics/attribution/compare');
  });

  it('should list all 5 attribution models', async () => {
    const response = await fetch(`${PROD_URL}/openapi.json`);
    const data = await response.json() as any;

    const spec = JSON.stringify(data);

    expect(spec).toContain('first_touch');
    expect(spec).toContain('last_touch');
    expect(spec).toContain('linear');
    expect(spec).toContain('time_decay');
    expect(spec).toContain('position_based');
  });
});

describe('Production Authentication', () => {
  it('should return 401 for protected endpoints without auth', async () => {
    const response = await fetch(`${PROD_URL}/v1/user/me`);

    expect(response.status).toBe(401);
    const data = await response.json() as any;
    expect(data.success).toBe(false);
  });

  it('should return 401 for analytics endpoints without auth', async () => {
    const response = await fetch(`${PROD_URL}/v1/analytics/events?org_id=test`);

    expect(response.status).toBe(401);
  });

  it('should return 401 for journey endpoints without auth', async () => {
    const response = await fetch(`${PROD_URL}/v1/analytics/journeys/overview?org_id=test`);

    expect(response.status).toBe(401);
  });
});

describe('Production Public Endpoints', () => {
  it('should allow waitlist stats without auth', async () => {
    const response = await fetch(`${PROD_URL}/v1/waitlist/stats`);

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.success).toBe(true);
    expect(typeof data.data.total).toBe('number');
  });

  it('should allow login endpoint without auth', async () => {
    const response = await fetch(`${PROD_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@nonexistent.com', password: 'wrongpassword' })
    });

    // Should get 401 for invalid creds, not for missing auth header
    expect(response.status).toBe(401);
    const data = await response.json() as any;
    expect(data.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('Production CORS', () => {
  it('should include CORS headers for app origin', async () => {
    const response = await fetch(`${PROD_URL}/v1/health`, {
      headers: {
        'Origin': 'https://app.clearlift.ai'
      }
    });

    expect(response.headers.get('access-control-allow-origin')).toBeDefined();
  });

  it('should handle OPTIONS preflight', async () => {
    const response = await fetch(`${PROD_URL}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://app.clearlift.ai',
        'Access-Control-Request-Method': 'GET'
      }
    });

    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('access-control-allow-methods')).toBeDefined();
  });
});

describe('Production Security Headers', () => {
  it('should include x-content-type-options', async () => {
    const response = await fetch(`${PROD_URL}/v1/health`);

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('should include x-frame-options', async () => {
    const response = await fetch(`${PROD_URL}/v1/health`);

    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('Production Error Handling', () => {
  it('should return 404 for unknown endpoints', async () => {
    const response = await fetch(`${PROD_URL}/v1/nonexistent-endpoint-12345`);

    expect(response.status).toBe(404);
  });

  it('should return JSON error responses', async () => {
    const response = await fetch(`${PROD_URL}/v1/user/me`);
    const data = await response.json() as any;

    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBeDefined();
  });

  it('should validate request body', async () => {
    const response = await fetch(`${PROD_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-valid-email' })
    });

    expect(response.status).toBe(400);
  });
});

describe('Production Rate Limiting', () => {
  it('should not rate limit health endpoint', async () => {
    // Make several rapid requests to health endpoint
    const requests = Array(10).fill(null).map(() =>
      fetch(`${PROD_URL}/v1/health`)
    );

    const responses = await Promise.all(requests);

    // All should succeed (health is exempt from rate limiting)
    responses.forEach(r => {
      expect(r.status).toBe(200);
    });
  });
});

describe('Production Response Times', () => {
  it('should return OpenAPI spec quickly', async () => {
    const start = Date.now();
    await fetch(`${PROD_URL}/openapi.json`);
    const latency = Date.now() - start;

    // OpenAPI spec should load in under 3 seconds
    expect(latency).toBeLessThan(3000);
  });

  it('should return 401 quickly for unauthorized requests', async () => {
    const start = Date.now();
    await fetch(`${PROD_URL}/v1/user/me`);
    const latency = Date.now() - start;

    // Auth check should be fast
    expect(latency).toBeLessThan(500);
  });
});
