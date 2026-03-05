/**
 * AnalyticsEngineService Tests
 *
 * Verifies SQL generation, blob/double column mapping, _sample_interval usage,
 * response transformation, and input sanitization.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnalyticsEngineService } from '../src/services/analytics-engine';

describe('AnalyticsEngineService', () => {
  let service: AnalyticsEngineService;
  let originalFetch: typeof global.fetch;
  let capturedSql: string;

  const ACCOUNT_ID = 'test-account-id';
  const API_TOKEN = 'test-api-token';
  const DATASET = 'adbliss_events_test';

  beforeEach(() => {
    originalFetch = global.fetch;
    service = new AnalyticsEngineService(ACCOUNT_ID, API_TOKEN, DATASET);
    capturedSql = '';

    // Default mock that captures SQL and returns empty data
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      capturedSql = init?.body || '';
      return {
        ok: true,
        json: async () => ({ data: [] }),
        text: async () => '',
      };
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ===========================================================================
  // Constructor & API URL
  // ===========================================================================

  describe('constructor', () => {
    it('should use provided dataset name', async () => {
      await service.getSummary('test_org', 1);
      expect(capturedSql).toContain(DATASET);
    });

    it('should default to adbliss_events dataset', async () => {
      const defaultService = new AnalyticsEngineService(ACCOUNT_ID, API_TOKEN);
      await defaultService.getSummary('test_org', 1);
      expect(capturedSql).toContain('adbliss_events');
    });

    it('should call correct AE SQL API URL', async () => {
      await service.getSummary('test_org', 1);
      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[0]).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`
      );
    });

    it('should send auth token in headers', async () => {
      await service.getSummary('test_org', 1);
      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[1].headers.Authorization).toBe(`Bearer ${API_TOKEN}`);
      expect(fetchCall[1].headers['Content-Type']).toBe('text/plain');
    });
  });

  // ===========================================================================
  // getSummary
  // ===========================================================================

  describe('getSummary', () => {
    it('should query correct doubles with _sample_interval', async () => {
      await service.getSummary('test_org', 24);

      // Must multiply by _sample_interval for accurate counts
      expect(capturedSql).toContain('SUM(_sample_interval * double1)'); // total_events
      expect(capturedSql).toContain('SUM(_sample_interval * double3)'); // sessions
      expect(capturedSql).toContain('SUM(_sample_interval * double7)'); // conversions
      expect(capturedSql).toContain('SUM(_sample_interval * double2)'); // revenue_cents
      expect(capturedSql).toContain('SUM(_sample_interval * double4)'); // page_views
      expect(capturedSql).toContain('COUNT(DISTINCT blob15)');          // unique users
    });

    it('should filter by org_tag via index1', async () => {
      await service.getSummary('my_org', 24);
      expect(capturedSql).toContain("index1 = 'my_org'");
    });

    it('should use hours parameter in INTERVAL', async () => {
      await service.getSummary('test_org', 48);
      expect(capturedSql).toContain("INTERVAL '48' HOUR");
    });

    it('should transform response correctly', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{
            total_events: 1000,
            new_sessions: 200,
            unique_users: 150,
            conversions: 10,
            revenue_cents: 50000,
            page_views: 800,
          }],
        }),
      });

      const result = await service.getSummary('test_org', 24);

      expect(result.totalEvents).toBe(1000);
      expect(result.sessions).toBe(200);
      expect(result.users).toBe(150);
      expect(result.conversions).toBe(10);
      expect(result.revenue).toBe(500); // 50000 cents / 100
      expect(result.pageViews).toBe(800);
    });

    it('should return zeros for empty result', async () => {
      const result = await service.getSummary('test_org', 24);

      expect(result.totalEvents).toBe(0);
      expect(result.sessions).toBe(0);
      expect(result.users).toBe(0);
      expect(result.conversions).toBe(0);
      expect(result.revenue).toBe(0);
      expect(result.pageViews).toBe(0);
    });
  });

  // ===========================================================================
  // getTimeSeries
  // ===========================================================================

  describe('getTimeSeries', () => {
    it('should use toStartOfHour by default', async () => {
      await service.getTimeSeries('test_org', 24);
      expect(capturedSql).toContain('toStartOfHour(timestamp)');
    });

    it('should use toStartOfFifteenMinutes for 15min interval', async () => {
      await service.getTimeSeries('test_org', 24, '15min');
      expect(capturedSql).toContain('toStartOfFifteenMinutes(timestamp)');
    });

    it('should include GROUP BY and ORDER BY bucket', async () => {
      await service.getTimeSeries('test_org', 24);
      expect(capturedSql).toContain('GROUP BY bucket');
      expect(capturedSql).toContain('ORDER BY bucket ASC');
    });

    it('should use _sample_interval for all metrics', async () => {
      await service.getTimeSeries('test_org', 24);
      expect(capturedSql).toContain('SUM(_sample_interval * double1)'); // events
      expect(capturedSql).toContain('SUM(_sample_interval * double3)'); // sessions
      expect(capturedSql).toContain('SUM(_sample_interval * double4)'); // page_views
      expect(capturedSql).toContain('SUM(_sample_interval * double7)'); // conversions
    });

    it('should transform response rows', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { bucket: '2026-03-05 14:00:00', events: 100, sessions: 20, page_views: 80, conversions: 2 },
            { bucket: '2026-03-05 15:00:00', events: 150, sessions: 30, page_views: 120, conversions: 5 },
          ],
        }),
      });

      const result = await service.getTimeSeries('test_org', 24);
      expect(result).toHaveLength(2);
      expect(result[0].bucket).toBe('2026-03-05 14:00:00');
      expect(result[0].events).toBe(100);
      expect(result[1].pageViews).toBe(120);
    });
  });

  // ===========================================================================
  // getBreakdown — dimension → blob column mapping
  // ===========================================================================

  describe('getBreakdown', () => {
    const dimensionToBlobMap: Record<string, string> = {
      utm_source:   'blob2',
      utm_medium:   'blob3',
      utm_campaign: 'blob4',
      device:       'blob5',
      country:      'blob6',
      browser:      'blob7',
      os:           'blob8',
      page:         'blob9',
      referrer:     'blob11',
      region:       'blob12',
      city:         'blob13',
    };

    for (const [dimension, expectedBlob] of Object.entries(dimensionToBlobMap)) {
      it(`should map "${dimension}" to ${expectedBlob}`, async () => {
        await service.getBreakdown('test_org', dimension as any, 24);
        expect(capturedSql).toContain(`${expectedBlob} as dimension`);
        expect(capturedSql).toContain(`GROUP BY ${expectedBlob}`);
        expect(capturedSql).toContain(`${expectedBlob} != ''`);
      });
    }

    it('should throw on unknown dimension', async () => {
      await expect(service.getBreakdown('test_org', 'invalid' as any, 24))
        .rejects.toThrow('Unknown dimension');
    });

    it('should LIMIT 50 results', async () => {
      await service.getBreakdown('test_org', 'utm_source', 24);
      expect(capturedSql).toContain('LIMIT 50');
    });

    it('should ORDER BY events DESC', async () => {
      await service.getBreakdown('test_org', 'utm_source', 24);
      expect(capturedSql).toContain('ORDER BY events DESC');
    });

    it('should convert revenue_cents to dollars', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ dimension: 'google', events: 100, sessions: 20, conversions: 5, revenue_cents: 12345 }],
        }),
      });

      const result = await service.getBreakdown('test_org', 'utm_source', 24);
      expect(result[0].revenue).toBe(123.45);
    });

    it('should default empty dimensions to "(not set)"', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ dimension: '', events: 50, sessions: 10, conversions: 0, revenue_cents: 0 }],
        }),
      });

      const result = await service.getBreakdown('test_org', 'utm_source', 24);
      expect(result[0].dimension).toBe('(not set)');
    });
  });

  // ===========================================================================
  // getEventTypes
  // ===========================================================================

  describe('getEventTypes', () => {
    it('should use blob1 for event_type', async () => {
      await service.getEventTypes('test_org', 24);
      expect(capturedSql).toContain('blob1 as dimension');
      expect(capturedSql).toContain('GROUP BY blob1');
    });

    it('should LIMIT 20 results', async () => {
      await service.getEventTypes('test_org', 24);
      expect(capturedSql).toContain('LIMIT 20');
    });

    it('should return typed breakdown rows', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { dimension: 'page_view', events: 500, sessions: 100, conversions: 0, revenue_cents: 0 },
            { dimension: 'click', events: 200, sessions: 80, conversions: 3, revenue_cents: 15000 },
          ],
        }),
      });

      const result = await service.getEventTypes('test_org', 24);
      expect(result).toHaveLength(2);
      expect(result[0].dimension).toBe('page_view');
      expect(result[1].revenue).toBe(150); // 15000 / 100
    });
  });

  // ===========================================================================
  // getRecentEvents
  // ===========================================================================

  describe('getRecentEvents', () => {
    it('should use MINUTE interval', async () => {
      await service.getRecentEvents('test_org', 5, 100);
      expect(capturedSql).toContain("INTERVAL '5' MINUTE");
    });

    it('should select correct blob columns', async () => {
      await service.getRecentEvents('test_org', 5, 100);
      expect(capturedSql).toContain('blob1 as event_type');
      expect(capturedSql).toContain('blob9 as page_path');
      expect(capturedSql).toContain('blob5 as device_type');
      expect(capturedSql).toContain('blob6 as country');
      expect(capturedSql).toContain('blob2 as utm_source');
      expect(capturedSql).toContain('double7 as is_conversion');
      expect(capturedSql).toContain('double2 as goal_value');
    });

    it('should ORDER BY timestamp DESC with LIMIT', async () => {
      await service.getRecentEvents('test_org', 10, 50);
      expect(capturedSql).toContain('ORDER BY timestamp DESC');
      expect(capturedSql).toContain('LIMIT 50');
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should throw on non-ok response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'Query syntax error near line 1',
      });

      await expect(service.getSummary('test_org', 24))
        .rejects.toThrow('Analytics Engine query failed');
    });

    it('should include error text in thrown message', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'cannot combine DateTime and String types',
      });

      await expect(service.getSummary('test_org', 24))
        .rejects.toThrow('cannot combine DateTime and String types');
    });
  });

  // ===========================================================================
  // Input sanitization
  // ===========================================================================

  describe('input sanitization', () => {
    it('should sanitize org_tag to prevent SQL injection', async () => {
      await service.getSummary("test'; DROP TABLE events; --", 24);
      // Sanitized value should not contain quotes or SQL keywords
      expect(capturedSql).not.toContain("DROP TABLE");
      expect(capturedSql).not.toContain("'; ");
    });

    it('should reject negative hours', async () => {
      await expect(service.getSummary('test_org', -1))
        .rejects.toThrow();
    });

    it('should accept zero hours (returns no data)', async () => {
      // validatePositiveInt allows 0 — it's a valid edge case
      const result = await service.getSummary('test_org', 0);
      expect(result.totalEvents).toBe(0);
    });
  });
});
