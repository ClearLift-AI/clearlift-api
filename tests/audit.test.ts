/**
 * Audit Tests — API
 *
 * Verifies:
 * 1. CAC summary endpoint returns per_source breakdown (migration 0043)
 * 2. sanitizeString blocks injection patterns
 * 3. validatePositiveInt rejects invalid inputs
 */

import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { sanitizeString, validatePositiveInt } from '../src/utils/sanitize';

// =========================================================================
// Pure function tests — sanitizeString
// =========================================================================

describe('sanitizeString', () => {
  it('should allow org_abc-123', () => {
    expect(sanitizeString('org_abc-123')).toBe('org_abc-123');
  });

  it('should allow alphanumeric with dots', () => {
    expect(sanitizeString('clearlift.events')).toBe('clearlift.events');
  });

  it('should strip single quotes and semicolons', () => {
    expect(sanitizeString("'; DROP TABLE")).toBe('DROPTABLE');
  });

  it('should strip SQL injection characters', () => {
    expect(sanitizeString("1' OR '1'='1")).toBe("1OR11");
  });

  it('should strip spaces and special chars', () => {
    expect(sanitizeString('hello world!')).toBe('helloworld');
  });

  it('should allow empty string', () => {
    expect(sanitizeString('')).toBe('');
  });
});

// =========================================================================
// Pure function tests — validatePositiveInt
// =========================================================================

describe('validatePositiveInt', () => {
  it('should reject -1', () => {
    expect(() => validatePositiveInt(-1, 'test')).toThrow('Invalid test');
  });

  it('should reject NaN', () => {
    expect(() => validatePositiveInt(NaN, 'test')).toThrow('Invalid test');
  });

  it('should reject 100001', () => {
    expect(() => validatePositiveInt(100001, 'test')).toThrow('Invalid test');
  });

  it('should reject Infinity', () => {
    expect(() => validatePositiveInt(Infinity, 'test')).toThrow('Invalid test');
  });

  it('should accept 0', () => {
    expect(validatePositiveInt(0, 'test')).toBe(0);
  });

  it('should accept 5000', () => {
    expect(validatePositiveInt(5000, 'test')).toBe(5000);
  });

  it('should accept 100000 (boundary)', () => {
    expect(validatePositiveInt(100000, 'test')).toBe(100000);
  });

  it('should floor floating point numbers', () => {
    expect(validatePositiveInt(5.7, 'test')).toBe(5);
  });
});

// =========================================================================
// Integration: CAC summary with per_source (requires auth + org + seeded data)
// =========================================================================

describe('CAC Summary per_source', () => {
  const testPassword = 'SecurePass123!';

  async function createTestUserWithOrg(prefix: string) {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const response = await SELF.fetch('http://localhost/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: testPassword,
        name: 'Audit Test User',
        organization_name: `Audit Org ${Date.now()}`
      })
    });
    const data = await response.json() as any;
    return {
      token: data.data?.session?.token as string,
      orgId: data.data?.organization?.id as string,
    };
  }

  it('should return per_source breakdown in CAC summary', async () => {
    const { token, orgId } = await createTestUserWithOrg('cac-audit');

    // Seed cac_history with per-source columns directly in ANALYTICS_DB
    // Use relative dates to avoid date range filter issues
    const today = new Date();
    const dateStr = (daysAgo: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() - daysAgo);
      return d.toISOString().split('T')[0];
    };
    const days = [
      { date: dateStr(3), spend: 50000, conv: 3, rev: 12500, cs: 2, csh: 1, cj: 0, ct: 0, rs: 8000, rsh: 4500, rj: 0 },
      { date: dateStr(2), spend: 45000, conv: 4, rev: 17500, cs: 2, csh: 1, cj: 0, ct: 1, rs: 9500, rsh: 6000, rj: 0 },
      { date: dateStr(1), spend: 55000, conv: 3, rev: 18000, cs: 1, csh: 1, cj: 1, ct: 0, rs: 10000, rsh: 8000, rj: 3000 },
    ];

    for (const d of days) {
      await env.ANALYTICS_DB.prepare(`
        INSERT INTO cac_history (
          id, organization_id, date, spend_cents, conversions, revenue_cents, cac_cents,
          conversions_goal, conversions_platform, conversion_source,
          conversions_stripe, conversions_shopify, conversions_jobber, conversions_tag,
          revenue_stripe_cents, revenue_shopify_cents, revenue_jobber_cents
        ) VALUES (
          lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?,
          ?, 0, 'goal',
          ?, ?, ?, ?,
          ?, ?, ?
        )
      `).bind(
        orgId, d.date, d.spend, d.conv, d.rev,
        d.conv > 0 ? Math.round(d.spend / d.conv) : 0,
        d.conv, d.cs, d.csh, d.cj, d.ct, d.rs, d.rsh, d.rj
      ).run();
    }

    // Call CAC summary endpoint
    const response = await SELF.fetch(
      `http://localhost/v1/analytics/cac/summary?org_id=${orgId}&days=7`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.success).toBe(true);

    const summary = result.data;

    // Verify per_source is present
    expect(summary.per_source).toBeDefined();
    expect(summary.per_source.stripe).toBeDefined();
    expect(summary.per_source.shopify).toBeDefined();
    expect(summary.per_source.jobber).toBeDefined();
    expect(summary.per_source.tag).toBeDefined();

    // Verify sums: stripe=5, shopify=3, jobber=1, tag=1
    expect(summary.per_source.stripe.conversions).toBe(5);
    expect(summary.per_source.shopify.conversions).toBe(3);
    expect(summary.per_source.jobber.conversions).toBe(1);
    expect(summary.per_source.tag.conversions).toBe(1);

    // Verify revenue sums
    expect(summary.per_source.stripe.revenue_cents).toBe(27500);
    expect(summary.per_source.shopify.revenue_cents).toBe(18500);
    expect(summary.per_source.jobber.revenue_cents).toBe(3000);

    // Verify total conversions and spend
    expect(summary.conversions).toBe(10);
    expect(summary.spend_cents).toBe(150000);
  });

  it('should return null when no cac_history exists', async () => {
    const { token, orgId } = await createTestUserWithOrg('cac-empty');

    const response = await SELF.fetch(
      `http://localhost/v1/analytics/cac/summary?org_id=${orgId}&days=7`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });
});
