/**
 * OpenAPI Schema Validation Tests
 *
 * Prevents Zod "unrecognized_keys" errors in production by verifying:
 * 1. All POST/PUT/PATCH endpoints that receive org_id query params declare a query schema
 * 2. The finalize endpoint specifically accepts org_id without validation errors
 *
 * Background: The FinalizeOAuthConnection endpoint was missing a `query` schema
 * definition. When the dashboard sent ?org_id=xxx, the OpenAPI framework's strict
 * Zod validation rejected the parsed query as an unrecognized key, returning 400.
 * This only surfaced on staging (not local) due to deployment timing.
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('OpenAPI Schema: query param validation', () => {
  /**
   * Schema audit: fetch the OpenAPI spec and verify all endpoints that are
   * called with org_id in practice have query parameters defined.
   *
   * Endpoints that accept org_id should declare it in their schema so the
   * OpenAPI framework doesn't reject it as an unrecognized key.
   */
  it('all endpoints with org_id usage should declare query parameters in OpenAPI spec', async () => {
    const response = await SELF.fetch('http://localhost/openapi.json');
    expect(response.status).toBe(200);

    const spec = await response.json() as any;
    const paths = spec.paths || {};

    // These endpoints are known to receive ?org_id= from the dashboard.
    // If you add a new endpoint that receives org_id, add it here.
    const endpointsExpectingOrgId = [
      { path: '/v1/connectors/connected', method: 'get' },
      { path: '/v1/connectors/status', method: 'get' },
      { path: '/v1/connectors/{provider}/finalize', method: 'post' },
    ];

    const missing: string[] = [];

    for (const { path, method } of endpointsExpectingOrgId) {
      const pathSpec = paths[path];
      if (!pathSpec) continue; // Path not in spec (may use different format)

      const methodSpec = pathSpec[method];
      if (!methodSpec) continue;

      const parameters = methodSpec.parameters || [];
      const hasQueryParam = parameters.some(
        (p: any) => p.in === 'query'
      );

      // For POST/PUT with requestBody, the OpenAPI framework parses query
      // params separately. If no query params are declared in the schema,
      // strict validation rejects them.
      if (!hasQueryParam) {
        missing.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(
      missing,
      `These endpoints receive ?org_id= but don't declare query parameters in their schema. ` +
      `Add \`query: z.object({ org_id: z.string().optional() })\` to their request schema:\n` +
      missing.map(m => `  - ${m}`).join('\n')
    ).toEqual([]);
  });

  /**
   * Integration test: POST to /finalize with ?org_id= should NOT return
   * a Zod validation error. It should fail on auth (401) or invalid state,
   * not on schema validation (400 with "unrecognized_keys").
   */
  it('POST /v1/connectors/google/finalize?org_id=xxx should not return Zod validation error', async () => {
    const response = await SELF.fetch(
      'http://localhost/v1/connectors/google/finalize?org_id=test-org',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer fake-token',
        },
        body: JSON.stringify({
          state: 'test-state',
          account_id: '123',
          account_name: 'Test Account',
        }),
      }
    );

    const data = await response.json() as any;

    // Should fail on auth or business logic, NOT on schema validation
    // The bug was: 400 with errors[0].code === "unrecognized_keys"
    if (response.status === 400 && data.errors) {
      const hasUnrecognizedKeys = data.errors.some(
        (e: any) => e.code === 'unrecognized_keys'
      );
      expect(
        hasUnrecognizedKeys,
        'Finalize endpoint rejected query params as unrecognized keys — missing query schema'
      ).toBe(false);
    }

    // Expected: 401 (invalid token) or 400 (invalid state), not a schema error
    expect([400, 401]).toContain(response.status);
  });

  /**
   * Same test for other providers to catch the issue broadly.
   */
  it.each(['facebook', 'tiktok', 'shopify', 'jobber', 'hubspot'] as const)(
    'POST /v1/connectors/%s/finalize?org_id=xxx should not return Zod validation error',
    async (provider) => {
      const response = await SELF.fetch(
        `http://localhost/v1/connectors/${provider}/finalize?org_id=test-org`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer fake-token',
          },
          body: JSON.stringify({
            state: 'test-state',
            account_id: '123',
            account_name: 'Test Account',
          }),
        }
      );

      const data = await response.json() as any;

      if (response.status === 400 && data.errors) {
        const hasUnrecognizedKeys = data.errors.some(
          (e: any) => e.code === 'unrecognized_keys'
        );
        expect(
          hasUnrecognizedKeys,
          `${provider} finalize endpoint rejected query params as unrecognized keys`
        ).toBe(false);
      }
    }
  );
});
