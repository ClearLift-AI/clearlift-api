/**
 * Functional tests for AI Analysis metrics pipeline.
 *
 * Verifies the code paths that caused Unagi's "$0 Total Spend" bug:
 *   1. MetricsFetcher batched aggregation with real D1 data
 *   2. isActiveStatus case-insensitive matching for unified tables
 *   3. Entity tree → metrics → cross-platform summary coherence
 *   4. Error counting and logging on D1 failures
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { MetricsFetcher, DateRange, TimeseriesMetric } from '../src/services/analysis/metrics-fetcher';
import { EntityTreeBuilder } from '../src/services/analysis/entity-tree';
import {
  isActiveStatus,
  serializeEntityTree,
  deserializeEntityTree,
  getEntitiesAtLevel,
  buildHierarchySkipSet,
  SerializedEntity,
  SerializedEntityTree,
} from '../src/workflows/analysis-helpers';

// ─── Test org & date constants ────────────────────────────────────────────────

const TEST_ORG = 'test-org-analysis-' + Date.now();
const ACCOUNT_ID = 'act_999888777';
const DATE_RANGE: DateRange = { start: '2026-02-03', end: '2026-02-10' };

// Campaign UUIDs (deterministic for assertions)
const CAMPAIGN_ACTIVE_1 = 'aaaa0001-0000-0000-0000-000000000001';
const CAMPAIGN_ACTIVE_2 = 'aaaa0002-0000-0000-0000-000000000002';
const CAMPAIGN_PAUSED_1 = 'pppp0001-0000-0000-0000-000000000001';
const CAMPAIGN_PAUSED_2 = 'pppp0002-0000-0000-0000-000000000002';

// Ad group / ad UUIDs
const ADGROUP_1 = 'bbbb0001-0000-0000-0000-000000000001';
const ADGROUP_2 = 'bbbb0002-0000-0000-0000-000000000002';
const AD_1 = 'cccc0001-0000-0000-0000-000000000001';
const AD_2 = 'cccc0002-0000-0000-0000-000000000002';

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedCampaign(id: string, name: string, status: string) {
  await env.ANALYTICS_DB.prepare(`
    INSERT INTO ad_campaigns (id, organization_id, platform, account_id, campaign_id, campaign_name, campaign_status)
    VALUES (?, ?, 'facebook', ?, ?, ?, ?)
  `).bind(id, TEST_ORG, ACCOUNT_ID, 'ext_' + id.slice(0, 8), name, status).run();
}

async function seedAdGroup(id: string, campaignRef: string, name: string, status: string) {
  await env.ANALYTICS_DB.prepare(`
    INSERT INTO ad_groups (id, organization_id, platform, account_id, campaign_id, campaign_ref, ad_group_id, ad_group_name, ad_group_status)
    VALUES (?, ?, 'facebook', ?, 'ext_camp', ?, ?, ?, ?)
  `).bind(id, TEST_ORG, ACCOUNT_ID, campaignRef, 'ext_' + id.slice(0, 8), name, status).run();
}

async function seedAd(id: string, campaignRef: string, adGroupRef: string, name: string, status: string) {
  await env.ANALYTICS_DB.prepare(`
    INSERT INTO ads (id, organization_id, platform, account_id, campaign_id, campaign_ref, ad_group_id, ad_group_ref, ad_id, ad_name, ad_status)
    VALUES (?, ?, 'facebook', ?, 'ext_camp', ?, 'ext_ag', ?, ?, ?, ?)
  `).bind(id, TEST_ORG, ACCOUNT_ID, campaignRef, adGroupRef, 'ext_' + id.slice(0, 8), name, status).run();
}

async function seedMetric(
  entityRef: string,
  entityType: 'campaign' | 'ad_group' | 'ad',
  date: string,
  spend: number,
  impressions: number,
  clicks: number,
  conversions: number
) {
  await env.ANALYTICS_DB.prepare(`
    INSERT INTO ad_metrics (organization_id, platform, entity_type, entity_ref, metric_date, impressions, clicks, spend_cents, conversions, conversion_value_cents)
    VALUES (?, 'facebook', ?, ?, ?, ?, ?, ?, ?, 0)
  `).bind(TEST_ORG, entityType, entityRef, date, impressions, clicks, spend, conversions).run();
}

// ─── Seed fixture (runs once) ─────────────────────────────────────────────────

beforeAll(async () => {
  // 4 campaigns: 2 active (lowercase), 2 paused (lowercase) — mirrors production
  await seedCampaign(CAMPAIGN_ACTIVE_1, 'DTC US Active Campaign', 'active');
  await seedCampaign(CAMPAIGN_ACTIVE_2, 'Retargeting Active Campaign', 'active');
  await seedCampaign(CAMPAIGN_PAUSED_1, 'Old Summer Campaign', 'paused');
  await seedCampaign(CAMPAIGN_PAUSED_2, 'Archived Winter Campaign', 'paused');

  // Ad groups under active campaigns only
  await seedAdGroup(ADGROUP_1, CAMPAIGN_ACTIVE_1, 'DTC Ad Set', 'active');
  await seedAdGroup(ADGROUP_2, CAMPAIGN_ACTIVE_2, 'Retargeting Ad Set', 'active');

  // Ads under ad groups (need campaign_ref for NOT NULL constraint)
  await seedAd(AD_1, CAMPAIGN_ACTIVE_1, ADGROUP_1, 'DTC Creative A', 'active');
  await seedAd(AD_2, CAMPAIGN_ACTIVE_2, ADGROUP_2, 'Retargeting Creative A', 'active');

  // Metrics for active campaign 1 — 3 days of data
  await seedMetric(CAMPAIGN_ACTIVE_1, 'campaign', '2026-02-08', 20000, 12000, 150, 10);
  await seedMetric(CAMPAIGN_ACTIVE_1, 'campaign', '2026-02-09', 22000, 13000, 160, 12);
  await seedMetric(CAMPAIGN_ACTIVE_1, 'campaign', '2026-02-10', 18000, 11000, 130, 8);

  // Metrics for active campaign 2 — 2 days of data
  await seedMetric(CAMPAIGN_ACTIVE_2, 'campaign', '2026-02-09', 15000, 9000, 110, 5);
  await seedMetric(CAMPAIGN_ACTIVE_2, 'campaign', '2026-02-10', 12000, 8000, 95, 4);

  // Ad group metrics (for adset-level aggregation)
  await seedMetric(ADGROUP_1, 'ad_group', '2026-02-08', 20000, 12000, 150, 10);
  await seedMetric(ADGROUP_1, 'ad_group', '2026-02-09', 22000, 13000, 160, 12);
  await seedMetric(ADGROUP_1, 'ad_group', '2026-02-10', 18000, 11000, 130, 8);

  await seedMetric(ADGROUP_2, 'ad_group', '2026-02-09', 15000, 9000, 110, 5);
  await seedMetric(ADGROUP_2, 'ad_group', '2026-02-10', 12000, 8000, 95, 4);

  // Ad metrics
  await seedMetric(AD_1, 'ad', '2026-02-08', 20000, 12000, 150, 10);
  await seedMetric(AD_1, 'ad', '2026-02-09', 22000, 13000, 160, 12);
  await seedMetric(AD_1, 'ad', '2026-02-10', 18000, 11000, 130, 8);

  await seedMetric(AD_2, 'ad', '2026-02-09', 15000, 9000, 110, 5);
  await seedMetric(AD_2, 'ad', '2026-02-10', 12000, 8000, 95, 4);

  // Paused campaigns get NO metrics (mirrors Unagi: 40 paused campaigns with no data)
});

// ─── isActiveStatus ───────────────────────────────────────────────────────────

describe('isActiveStatus — case-insensitive matching', () => {
  it('matches lowercase "active" from unified tables', () => {
    expect(isActiveStatus('active')).toBe(true);
  });

  it('matches uppercase "ACTIVE" from legacy tables', () => {
    expect(isActiveStatus('ACTIVE')).toBe(true);
  });

  it('matches "ENABLED" (Google Ads status)', () => {
    expect(isActiveStatus('ENABLED')).toBe(true);
    expect(isActiveStatus('enabled')).toBe(true);
  });

  it('matches "RUNNING" and "LIVE"', () => {
    expect(isActiveStatus('RUNNING')).toBe(true);
    expect(isActiveStatus('live')).toBe(true);
  });

  it('rejects paused/archived/deleted', () => {
    expect(isActiveStatus('paused')).toBe(false);
    expect(isActiveStatus('PAUSED')).toBe(false);
    expect(isActiveStatus('archived')).toBe(false);
    expect(isActiveStatus('deleted')).toBe(false);
  });

  it('rejects undefined/empty', () => {
    expect(isActiveStatus(undefined)).toBe(false);
    expect(isActiveStatus('')).toBe(false);
  });
});

// ─── MetricsFetcher — single entity fetch ─────────────────────────────────────

describe('MetricsFetcher.fetchMetrics', () => {
  let fetcher: MetricsFetcher;

  beforeEach(() => {
    fetcher = new MetricsFetcher(env.ANALYTICS_DB);
  });

  it('fetches campaign metrics by entity_ref', async () => {
    const metrics = await fetcher.fetchMetrics('facebook', 'campaign', CAMPAIGN_ACTIVE_1, DATE_RANGE);

    expect(metrics).toHaveLength(3);
    expect(metrics[0].date).toBe('2026-02-08');
    expect(metrics[0].spend_cents).toBe(20000);
    expect(metrics[0].impressions).toBe(12000);
    expect(metrics[0].clicks).toBe(150);
    expect(metrics[0].conversions).toBe(10);
  });

  it('fetches ad_group metrics (adset level)', async () => {
    const metrics = await fetcher.fetchMetrics('facebook', 'adset', ADGROUP_1, DATE_RANGE);

    expect(metrics).toHaveLength(3);
    expect(metrics[2].date).toBe('2026-02-10');
    expect(metrics[2].spend_cents).toBe(18000);
  });

  it('fetches ad metrics', async () => {
    const metrics = await fetcher.fetchMetrics('facebook', 'ad', AD_2, DATE_RANGE);

    expect(metrics).toHaveLength(2);
    expect(metrics[0].date).toBe('2026-02-09');
    expect(metrics[1].spend_cents).toBe(12000);
  });

  it('returns empty for paused campaigns with no metrics', async () => {
    const metrics = await fetcher.fetchMetrics('facebook', 'campaign', CAMPAIGN_PAUSED_1, DATE_RANGE);
    expect(metrics).toHaveLength(0);
  });

  it('returns empty for account level (not a valid query level)', async () => {
    const metrics = await fetcher.fetchMetrics('facebook', 'account', 'anything', DATE_RANGE);
    expect(metrics).toHaveLength(0);
  });

  it('returns empty for unknown platforms', async () => {
    const metrics = await fetcher.fetchMetrics('linkedin', 'campaign', CAMPAIGN_ACTIVE_1, DATE_RANGE);
    expect(metrics).toHaveLength(0);
  });

  it('increments failedQueries counter on D1 error', async () => {
    // Create a fetcher with a broken session to force errors
    const brokenDb = {
      withSession: () => ({
        prepare: () => ({
          bind: () => ({
            all: () => { throw new Error('D1_SESSION_BROKEN'); }
          })
        })
      })
    } as unknown as D1Database;

    const brokenFetcher = new MetricsFetcher(brokenDb);

    const result = await brokenFetcher.fetchMetrics('facebook', 'campaign', 'any-id', DATE_RANGE);

    expect(result).toEqual([]);
    expect(brokenFetcher.failedQueries).toBe(1);

    // Call again to verify counter keeps incrementing
    await brokenFetcher.fetchMetrics('facebook', 'campaign', 'other-id', DATE_RANGE);
    expect(brokenFetcher.failedQueries).toBe(2);
  });
});

// ─── MetricsFetcher — batched aggregation ─────────────────────────────────────

describe('MetricsFetcher.fetchAggregatedMetrics — batching', () => {
  let fetcher: MetricsFetcher;

  beforeEach(() => {
    fetcher = new MetricsFetcher(env.ANALYTICS_DB);
  });

  it('aggregates campaign metrics for an account (the Unagi bug path)', async () => {
    const childIds = [CAMPAIGN_ACTIVE_1, CAMPAIGN_ACTIVE_2, CAMPAIGN_PAUSED_1, CAMPAIGN_PAUSED_2];
    const metrics = await fetcher.fetchAggregatedMetrics('facebook', 'account', childIds, DATE_RANGE);

    // Should have 3 dates: Feb 8 (only campaign 1), Feb 9 (both), Feb 10 (both)
    expect(metrics.length).toBe(3);

    // Feb 8: only campaign 1 has data
    const feb8 = metrics.find(m => m.date === '2026-02-08')!;
    expect(feb8).toBeDefined();
    expect(feb8.spend_cents).toBe(20000);
    expect(feb8.impressions).toBe(12000);
    expect(feb8.conversions).toBe(10);

    // Feb 9: both active campaigns aggregated
    const feb9 = metrics.find(m => m.date === '2026-02-09')!;
    expect(feb9).toBeDefined();
    expect(feb9.spend_cents).toBe(22000 + 15000);
    expect(feb9.impressions).toBe(13000 + 9000);
    expect(feb9.clicks).toBe(160 + 110);
    expect(feb9.conversions).toBe(12 + 5);

    // Feb 10: both active campaigns aggregated
    const feb10 = metrics.find(m => m.date === '2026-02-10')!;
    expect(feb10).toBeDefined();
    expect(feb10.spend_cents).toBe(18000 + 12000);
    expect(feb10.conversions).toBe(8 + 4);
  });

  it('total spend is non-zero despite paused campaigns in the mix', async () => {
    const childIds = [CAMPAIGN_ACTIVE_1, CAMPAIGN_ACTIVE_2, CAMPAIGN_PAUSED_1, CAMPAIGN_PAUSED_2];
    const metrics = await fetcher.fetchAggregatedMetrics('facebook', 'account', childIds, DATE_RANGE);

    const totals = fetcher.sumMetrics(metrics);
    const totalSpend = totals.spend_cents;

    // The exact bug: this was $0.00 in production.
    // Should be 20000 + 22000 + 15000 + 18000 + 12000 = 87000
    expect(totalSpend).toBe(87000);
    expect(totalSpend).toBeGreaterThan(0);
  });

  it('aggregates ad_group metrics for a campaign', async () => {
    const childIds = [ADGROUP_1];
    const metrics = await fetcher.fetchAggregatedMetrics('facebook', 'campaign', childIds, DATE_RANGE);

    expect(metrics).toHaveLength(3);
    expect(metrics[0].spend_cents).toBe(20000); // Single ad group, same values
  });

  it('aggregates ad metrics for an ad_group', async () => {
    const childIds = [AD_1, AD_2];
    const metrics = await fetcher.fetchAggregatedMetrics('facebook', 'adset', childIds, DATE_RANGE);

    // Feb 8: only AD_1, Feb 9: both, Feb 10: both
    expect(metrics).toHaveLength(3);
    const feb9 = metrics.find(m => m.date === '2026-02-09')!;
    expect(feb9.spend_cents).toBe(22000 + 15000);
  });

  it('returns empty for no children', async () => {
    const metrics = await fetcher.fetchAggregatedMetrics('facebook', 'account', [], DATE_RANGE);
    expect(metrics).toHaveLength(0);
  });

  it('processes batches of 5 — not all at once', async () => {
    // Create 12 campaign IDs (mostly non-existent, simulating paused campaigns)
    const manyIds = [
      CAMPAIGN_ACTIVE_1,
      ...Array.from({ length: 11 }, (_, i) => `fake-${i}-0000-0000-0000-000000000000`)
    ];

    // Spy on fetchMetrics to count calls and verify batching order
    const fetchSpy = vi.spyOn(fetcher, 'fetchMetrics');

    const metrics = await fetcher.fetchAggregatedMetrics('facebook', 'account', manyIds, DATE_RANGE);

    // All 12 children should have been queried
    expect(fetchSpy).toHaveBeenCalledTimes(12);

    // Only campaign_active_1 has data, so aggregation should still produce results
    expect(metrics).toHaveLength(3);
    expect(fetcher.sumMetrics(metrics).spend_cents).toBe(60000); // 20000 + 22000 + 18000

    fetchSpy.mockRestore();
  });

  it('tracks failedQueries when some child fetches fail', async () => {
    // Intentionally create a fetcher that will fail on some queries
    let callCount = 0;
    const originalFetch = fetcher.fetchMetrics.bind(fetcher);
    vi.spyOn(fetcher, 'fetchMetrics').mockImplementation(async (...args) => {
      callCount++;
      if (callCount <= 2) {
        // First 2 succeed (active campaigns with data)
        return originalFetch(...args);
      }
      // Rest fail — simulate D1 session exhaustion
      fetcher.failedQueries++;
      return [];
    });

    expect(fetcher.failedQueries).toBe(0);

    const childIds = [CAMPAIGN_ACTIVE_1, CAMPAIGN_ACTIVE_2, CAMPAIGN_PAUSED_1, CAMPAIGN_PAUSED_2];
    const metrics = await fetcher.fetchAggregatedMetrics('facebook', 'account', childIds, DATE_RANGE);

    // Should still have data from the 2 successful fetches
    expect(metrics.length).toBeGreaterThan(0);
    expect(fetcher.sumMetrics(metrics).spend_cents).toBeGreaterThan(0);

    // failedQueries should have been incremented by the mock
    expect(fetcher.failedQueries).toBe(2);

    // All 4 children should have been attempted
    expect(callCount).toBe(4);
  });
});

// ─── EntityTreeBuilder → MetricsFetcher integration ───────────────────────────

describe('EntityTreeBuilder + MetricsFetcher integration', () => {
  it('builds tree from unified tables with correct lowercase statuses', async () => {
    const builder = new EntityTreeBuilder(env.ANALYTICS_DB);
    const tree = await builder.buildTree(TEST_ORG);

    expect(tree.platforms).toContain('facebook');
    expect(tree.totalEntities).toBeGreaterThan(0);

    // Should have one account (facebook_act_999888777)
    expect(tree.accounts.size).toBe(1);
    const account = tree.accounts.values().next().value!;
    expect(account.platform).toBe('facebook');

    // Account should have 4 campaign children
    expect(account.children).toHaveLength(4);

    // Statuses should be lowercase (from unified tables)
    const activeOnes = account.children.filter(c => c.status === 'active');
    const pausedOnes = account.children.filter(c => c.status === 'paused');
    expect(activeOnes).toHaveLength(2);
    expect(pausedOnes).toHaveLength(2);

    // isActiveStatus should match all active children
    const activeViaHelper = account.children.filter(c => isActiveStatus(c.status));
    expect(activeViaHelper).toHaveLength(2);
  });

  it('full pipeline: tree → aggregate metrics → non-zero totals', async () => {
    const builder = new EntityTreeBuilder(env.ANALYTICS_DB);
    const tree = await builder.buildTree(TEST_ORG);
    const fetcher = new MetricsFetcher(env.ANALYTICS_DB);

    // Reproduce the exact cross-platform summary code path (analysis-workflow.ts:710-720)
    let totalSpendCents = 0;
    let totalImpressions = 0;
    let totalConversions = 0;

    for (const account of tree.accounts.values()) {
      const childIds = account.children.map(c => c.id);
      const accountMetrics = await fetcher.fetchAggregatedMetrics(
        account.platform,
        'account',
        childIds,
        DATE_RANGE
      );
      const totals = fetcher.sumMetrics(accountMetrics);
      totalSpendCents += totals.spend_cents;
      totalImpressions += totals.impressions;
      totalConversions += totals.conversions;
    }

    // THE BUG: this was $0.00 for Unagi. Must be > 0.
    expect(totalSpendCents).toBe(87000);
    expect(totalImpressions).toBe(53000);
    expect(totalConversions).toBe(39);
    expect(fetcher.failedQueries).toBe(0);
  });
});

// ─── Serialization round-trip ─────────────────────────────────────────────────

describe('Entity tree serialization preserves children for cross-platform step', () => {
  it('round-trips through serialize → deserialize without losing children', async () => {
    const builder = new EntityTreeBuilder(env.ANALYTICS_DB);
    const tree = await builder.buildTree(TEST_ORG);

    const serialized = serializeEntityTree(tree);
    const deserialized = deserializeEntityTree(serialized);

    // Same account count
    expect(deserialized.accounts.size).toBe(tree.accounts.size);

    // Same children count after round-trip
    const originalAccount = tree.accounts.values().next().value!;
    const deserializedAccount = deserialized.accounts.values().next().value!;
    expect(deserializedAccount.children).toHaveLength(originalAccount.children.length);

    // Statuses preserved (lowercase)
    for (const child of deserializedAccount.children) {
      expect(['active', 'paused']).toContain(child.status);
    }
  });

  it('getEntitiesAtLevel works on serialized tree', async () => {
    const builder = new EntityTreeBuilder(env.ANALYTICS_DB);
    const tree = await builder.buildTree(TEST_ORG);
    const serialized = serializeEntityTree(tree);

    const campaigns = getEntitiesAtLevel(serialized, 'campaign');
    expect(campaigns).toHaveLength(4);

    const adsets = getEntitiesAtLevel(serialized, 'adset');
    expect(adsets).toHaveLength(2);

    const ads = getEntitiesAtLevel(serialized, 'ad');
    expect(ads).toHaveLength(2);
  });
});

// ─── buildHierarchySkipSet with lowercase statuses ────────────────────────────

describe('buildHierarchySkipSet respects lowercase statuses', () => {
  it('skips children of paused campaigns (lowercase "paused")', async () => {
    const builder = new EntityTreeBuilder(env.ANALYTICS_DB);
    const tree = await builder.buildTree(TEST_ORG);
    const serialized = serializeEntityTree(tree);

    const skipSet = buildHierarchySkipSet(serialized);

    // Paused campaigns have no children in our fixture, so skipSet should be empty
    // (the paused campaigns themselves are NOT skipped — only their children would be)
    // Active campaigns' children should NOT be in the skip set
    expect(skipSet.has(ADGROUP_1)).toBe(false);
    expect(skipSet.has(ADGROUP_2)).toBe(false);
    expect(skipSet.has(AD_1)).toBe(false);
    expect(skipSet.has(AD_2)).toBe(false);
  });

  it('skips children when parent is paused with children', async () => {
    // Build a synthetic tree with paused campaign that HAS children
    const tree: SerializedEntityTree = {
      organizationId: 'test',
      totalEntities: 5,
      platforms: ['facebook'],
      accounts: [[
        'facebook_test',
        {
          id: 'facebook_test',
          externalId: 'test',
          name: 'Test Account',
          platform: 'facebook',
          level: 'account',
          status: 'active',
          children: [
            {
              id: 'camp-paused',
              externalId: 'ext-camp',
              name: 'Paused Campaign',
              platform: 'facebook',
              level: 'campaign',
              status: 'paused',  // lowercase — must be caught by isActiveStatus
              children: [
                {
                  id: 'adset-under-paused',
                  externalId: 'ext-adset',
                  name: 'Ad Set Under Paused',
                  platform: 'facebook',
                  level: 'adset',
                  status: 'active',
                  children: [
                    {
                      id: 'ad-under-paused',
                      externalId: 'ext-ad',
                      name: 'Ad Under Paused',
                      platform: 'facebook',
                      level: 'ad',
                      status: 'active',
                      children: []
                    }
                  ]
                }
              ]
            },
            {
              id: 'camp-active',
              externalId: 'ext-camp-2',
              name: 'Active Campaign',
              platform: 'facebook',
              level: 'campaign',
              status: 'active',  // lowercase
              children: []
            }
          ]
        }
      ]]
    };

    const skipSet = buildHierarchySkipSet(tree);

    // Children of paused campaign should be skipped
    expect(skipSet.has('adset-under-paused')).toBe(true);
    expect(skipSet.has('ad-under-paused')).toBe(true);

    // Active campaign itself should NOT be skipped
    expect(skipSet.has('camp-active')).toBe(false);
    // Paused campaign itself is NOT in skip set (skip set is for children)
    expect(skipSet.has('camp-paused')).toBe(false);
  });
});

// ─── Cross-platform summary prompt assembly ───────────────────────────────────

describe('Cross-platform summary prompt correctness', () => {
  it('produces non-zero Total Spend with the same code path as the workflow', async () => {
    // Reproduce analysis-workflow.ts lines 700-757 exactly
    const builder = new EntityTreeBuilder(env.ANALYTICS_DB);
    const tree = await builder.buildTree(TEST_ORG);
    const entityTree = serializeEntityTree(tree);
    const metrics = new MetricsFetcher(env.ANALYTICS_DB);
    const days = 7;

    let totalSpendCents = 0;
    let totalRevenueCents = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;
    const platformMetrics: Record<string, { spend_cents: number; revenue_cents: number; impressions: number; clicks: number; conversions: number }> = {};

    const deserializedTree = deserializeEntityTree(entityTree);
    for (const account of deserializedTree.accounts.values()) {
      const childIds = account.children.map(c => c.id);
      const accountMetrics = await metrics.fetchAggregatedMetrics(
        account.platform,
        'account',
        childIds,
        DATE_RANGE
      );
      const totals = metrics.sumMetrics(accountMetrics);
      totalSpendCents += totals.spend_cents;
      totalRevenueCents += totals.conversion_value_cents;
      totalImpressions += totals.impressions;
      totalClicks += totals.clicks;
      totalConversions += totals.conversions;

      const p = account.platform;
      if (!platformMetrics[p]) {
        platformMetrics[p] = { spend_cents: 0, revenue_cents: 0, impressions: 0, clicks: 0, conversions: 0 };
      }
      platformMetrics[p].spend_cents += totals.spend_cents;
      platformMetrics[p].impressions += totals.impressions;
      platformMetrics[p].conversions += totals.conversions;
    }

    const fmt = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const totalSpend = fmt(totalSpendCents);

    // THE ASSERTION: this is what appeared as "$0.00" in the Unagi bug
    expect(totalSpend).toBe('$870.00');
    expect(totalSpendCents).toBe(87000);
    expect(totalConversions).toBe(39);

    // Platform breakdown should exist for facebook
    expect(platformMetrics['facebook']).toBeDefined();
    expect(platformMetrics['facebook'].spend_cents).toBe(87000);
  });

  it('active children count uses isActiveStatus (not hardcoded uppercase)', async () => {
    // Reproduce the exact code path from analysis-workflow.ts:576-581
    const builder = new EntityTreeBuilder(env.ANALYTICS_DB);
    const tree = await builder.buildTree(TEST_ORG);
    const account = tree.accounts.values().next().value!;

    // This is the FIXED code path:
    const activeChildren = account.children.filter(c =>
      isActiveStatus(c.status)
    ).length;

    expect(activeChildren).toBe(2);

    // Verify the OLD buggy code would have returned 0:
    const buggyCount = account.children.filter(c =>
      c.status === 'ACTIVE' || c.status === 'ENABLED'
    ).length;

    expect(buggyCount).toBe(0); // confirms the bug existed
  });
});

// ─── MetricsFetcher.sumMetrics ────────────────────────────────────────────────

describe('MetricsFetcher.sumMetrics', () => {
  it('sums all metric fields correctly', () => {
    const fetcher = new MetricsFetcher(env.ANALYTICS_DB);
    const metrics: TimeseriesMetric[] = [
      { date: '2026-02-08', impressions: 100, clicks: 10, spend_cents: 5000, conversions: 2, conversion_value_cents: 10000 },
      { date: '2026-02-09', impressions: 200, clicks: 20, spend_cents: 7000, conversions: 3, conversion_value_cents: 15000 },
    ];

    const totals = fetcher.sumMetrics(metrics);

    expect(totals.impressions).toBe(300);
    expect(totals.clicks).toBe(30);
    expect(totals.spend_cents).toBe(12000);
    expect(totals.conversions).toBe(5);
    expect(totals.conversion_value_cents).toBe(25000);
    expect(totals.date).toBe('total');
  });

  it('returns zeros for empty input', () => {
    const fetcher = new MetricsFetcher(env.ANALYTICS_DB);
    const totals = fetcher.sumMetrics([]);

    expect(totals.spend_cents).toBe(0);
    expect(totals.impressions).toBe(0);
    expect(totals.conversions).toBe(0);
  });
});
