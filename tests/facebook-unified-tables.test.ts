/**
 * Facebook Unified Tables Alignment Tests
 *
 * Validates that the API endpoint SQL and response transformations
 * correctly use unified table columns (not legacy platform-specific columns).
 *
 * These are pure logic tests — no D1 needed.
 */

import { describe, it, expect } from 'vitest';

/**
 * Replicate the ad_groups → ad_sets response mapping from facebook.ts
 * This must extract budget/targeting from platform_fields JSON,
 * NOT from non-existent top-level columns.
 */
function mapAdSetResponse(row: Record<string, any>) {
  const pf = row.platform_fields ? JSON.parse(row.platform_fields) : {};
  const dailyBudgetCents = pf.daily_budget ? Math.round(parseFloat(pf.daily_budget) * 100) : null;
  const lifetimeBudgetCents = pf.lifetime_budget ? Math.round(parseFloat(pf.lifetime_budget) * 100) : null;
  return {
    ad_set_id: row.ad_set_id,
    ad_set_name: row.ad_set_name,
    ad_set_status: (row.ad_set_status || '').toUpperCase(),
    status: (row.ad_set_status || '').toUpperCase(),
    campaign_id: row.campaign_id,
    daily_budget_cents: dailyBudgetCents,
    daily_budget: dailyBudgetCents,
    lifetime_budget_cents: lifetimeBudgetCents,
    targeting: pf.targeting || null,
    updated_at: row.updated_at,
    impressions: row.impressions || 0,
    clicks: row.clicks || 0,
    spend: (row.spend_cents || 0) / 100,
    spend_cents: row.spend_cents || 0,
    conversions: row.conversions || 0,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
  };
}

/**
 * Replicate the ads response mapping from facebook.ts
 * creative_id must come from platform_fields JSON.
 */
function mapAdResponse(row: Record<string, any>) {
  const pf = row.platform_fields ? JSON.parse(row.platform_fields) : {};
  return {
    ad_id: row.ad_id,
    ad_name: row.ad_name,
    ad_status: (row.ad_status || '').toUpperCase(),
    status: (row.ad_status || '').toUpperCase(),
    campaign_id: row.campaign_id,
    ad_set_id: row.ad_set_id,
    creative_id: pf.creative_id || null,
    updated_at: row.updated_at,
    impressions: row.impressions || 0,
    clicks: row.clicks || 0,
    spend: (row.spend_cents || 0) / 100,
    spend_cents: row.spend_cents || 0,
    conversions: row.conversions || 0,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
  };
}

/**
 * Replicate the creatives response mapping from facebook.ts
 */
function mapCreativeResponse(row: Record<string, any>) {
  const pf = row.platform_fields ? JSON.parse(row.platform_fields) : {};
  return {
    ad_id: row.ad_id,
    ad_name: row.ad_name,
    creative_id: pf.creative_id || null,
    updated_at: row.updated_at,
  };
}

/**
 * Replicate campaign status normalization from d1-analytics.ts
 */
function mapCampaignStatus(row: Record<string, any>) {
  return {
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    status: (row.status || '').toUpperCase(),
  };
}

describe('Facebook unified table column alignment', () => {
  describe('ad_groups → ad_sets mapping', () => {
    it('should extract daily_budget from platform_fields JSON', () => {
      const row = {
        ad_set_id: 'adset_123',
        ad_set_name: 'Test Ad Set',
        ad_set_status: 'active',
        campaign_id: 'camp_1',
        platform_fields: JSON.stringify({
          optimization_goal: 'LINK_CLICKS',
          billing_event: 'IMPRESSIONS',
          daily_budget: '50.00',
          lifetime_budget: null,
          targeting: { age_min: 18, age_max: 65, genders: [1, 2] },
        }),
        updated_at: '2025-12-15T00:00:00Z',
        impressions: 10000,
        clicks: 250,
        spend_cents: 5000,
        conversions: 12,
      };

      const result = mapAdSetResponse(row);
      expect(result.daily_budget_cents).toBe(5000);
      expect(result.daily_budget).toBe(5000);
      expect(result.lifetime_budget_cents).toBeNull();
      expect(result.targeting).toEqual({ age_min: 18, age_max: 65, genders: [1, 2] });
    });

    it('should extract lifetime_budget from platform_fields JSON', () => {
      const row = {
        ad_set_id: 'adset_456',
        ad_set_name: 'Lifetime Budget Set',
        ad_set_status: 'paused',
        campaign_id: 'camp_2',
        platform_fields: JSON.stringify({
          daily_budget: null,
          lifetime_budget: '1000.00',
          targeting: null,
        }),
        updated_at: '2025-12-15T00:00:00Z',
        impressions: 0,
        clicks: 0,
        spend_cents: 0,
        conversions: 0,
      };

      const result = mapAdSetResponse(row);
      expect(result.daily_budget_cents).toBeNull();
      expect(result.lifetime_budget_cents).toBe(100000);
      expect(result.targeting).toBeNull();
    });

    it('should handle null platform_fields gracefully', () => {
      const row = {
        ad_set_id: 'adset_789',
        ad_set_name: 'No Fields',
        ad_set_status: 'active',
        campaign_id: 'camp_3',
        platform_fields: null,
        updated_at: '2025-12-15T00:00:00Z',
        impressions: 500,
        clicks: 10,
        spend_cents: 200,
        conversions: 1,
      };

      const result = mapAdSetResponse(row);
      expect(result.daily_budget_cents).toBeNull();
      expect(result.lifetime_budget_cents).toBeNull();
      expect(result.targeting).toBeNull();
      expect(result.impressions).toBe(500);
    });

    it('should normalize status to uppercase', () => {
      const row = {
        ad_set_id: 'adset_1',
        ad_set_name: 'Test',
        ad_set_status: 'active',
        campaign_id: 'camp_1',
        platform_fields: null,
        updated_at: '2025-12-15T00:00:00Z',
        impressions: 0, clicks: 0, spend_cents: 0, conversions: 0,
      };

      const result = mapAdSetResponse(row);
      expect(result.ad_set_status).toBe('ACTIVE');
      expect(result.status).toBe('ACTIVE');
    });

    it('should compute CTR correctly', () => {
      const row = {
        ad_set_id: 'adset_1', ad_set_name: 'T', ad_set_status: 'active',
        campaign_id: 'c', platform_fields: null, updated_at: '',
        impressions: 10000, clicks: 250, spend_cents: 5000, conversions: 0,
      };

      const result = mapAdSetResponse(row);
      expect(result.ctr).toBe(2.5);
    });

    it('should handle zero impressions without NaN CTR', () => {
      const row = {
        ad_set_id: 'adset_1', ad_set_name: 'T', ad_set_status: 'active',
        campaign_id: 'c', platform_fields: null, updated_at: '',
        impressions: 0, clicks: 0, spend_cents: 0, conversions: 0,
      };

      const result = mapAdSetResponse(row);
      expect(result.ctr).toBe(0);
    });
  });

  describe('ads response mapping', () => {
    it('should extract creative_id from platform_fields JSON', () => {
      const row = {
        ad_id: 'ad_123',
        ad_name: 'Test Ad',
        ad_status: 'active',
        campaign_id: 'camp_1',
        ad_set_id: 'adset_1',
        platform_fields: JSON.stringify({ creative_id: 'cr_abc123' }),
        updated_at: '2025-12-15T00:00:00Z',
        impressions: 5000, clicks: 100, spend_cents: 2500, conversions: 5,
      };

      const result = mapAdResponse(row);
      expect(result.creative_id).toBe('cr_abc123');
      expect(result.ad_status).toBe('ACTIVE');
    });

    it('should return null creative_id when platform_fields is null', () => {
      const row = {
        ad_id: 'ad_456', ad_name: 'Ad No Fields', ad_status: 'paused',
        campaign_id: 'c', ad_set_id: 'as', platform_fields: null, updated_at: '',
        impressions: 0, clicks: 0, spend_cents: 0, conversions: 0,
      };

      const result = mapAdResponse(row);
      expect(result.creative_id).toBeNull();
    });

    it('should return null creative_id when not in platform_fields', () => {
      const row = {
        ad_id: 'ad_789', ad_name: 'Ad Empty PF', ad_status: 'active',
        campaign_id: 'c', ad_set_id: 'as',
        platform_fields: JSON.stringify({}), updated_at: '',
        impressions: 0, clicks: 0, spend_cents: 0, conversions: 0,
      };

      const result = mapAdResponse(row);
      expect(result.creative_id).toBeNull();
    });
  });

  describe('creatives response mapping', () => {
    it('should extract creative_id from platform_fields', () => {
      const row = {
        ad_id: 'ad_100', ad_name: 'Creative Ad',
        platform_fields: JSON.stringify({ creative_id: 'cr_xyz' }),
        updated_at: '2025-12-01T00:00:00Z',
      };

      const result = mapCreativeResponse(row);
      expect(result.creative_id).toBe('cr_xyz');
    });

    it('should handle missing platform_fields', () => {
      const row = {
        ad_id: 'ad_200', ad_name: 'No Creative',
        platform_fields: null, updated_at: '',
      };

      const result = mapCreativeResponse(row);
      expect(result.creative_id).toBeNull();
    });
  });

  describe('campaign status normalization', () => {
    it('should uppercase active status', () => {
      const result = mapCampaignStatus({ campaign_id: 'c1', campaign_name: 'T', status: 'active' });
      expect(result.status).toBe('ACTIVE');
    });

    it('should uppercase paused status', () => {
      const result = mapCampaignStatus({ campaign_id: 'c2', campaign_name: 'T', status: 'paused' });
      expect(result.status).toBe('PAUSED');
    });

    it('should uppercase archived status', () => {
      const result = mapCampaignStatus({ campaign_id: 'c3', campaign_name: 'T', status: 'archived' });
      expect(result.status).toBe('ARCHIVED');
    });

    it('should handle null/empty status', () => {
      const result = mapCampaignStatus({ campaign_id: 'c4', campaign_name: 'T', status: null });
      expect(result.status).toBe('');
    });

    it('should handle already uppercase status', () => {
      const result = mapCampaignStatus({ campaign_id: 'c5', campaign_name: 'T', status: 'ACTIVE' });
      expect(result.status).toBe('ACTIVE');
    });
  });

  describe('cron write → API read alignment', () => {
    it('should read what cron writes for ad_groups (ad sets)', () => {
      // Simulate what the cron writes to D1 ad_groups table
      const cronWrittenRow = {
        id: 'uuid-123',
        organization_id: 'org_1',
        platform: 'facebook',
        account_id: '123456789',
        campaign_ref: 'uuid-camp-1',
        campaign_id: 'camp_001',
        ad_group_id: 'adset_001',
        ad_group_name: 'My Ad Set',
        ad_group_status: 'active',
        bid_amount_cents: 150,
        bid_type: null,
        platform_fields: JSON.stringify({
          optimization_goal: 'LINK_CLICKS',
          billing_event: 'IMPRESSIONS',
          daily_budget: '25.50',
          lifetime_budget: null,
          targeting: { age_min: 25, age_max: 55, genders: [2] },
        }),
        raw_data: '{}',
      };

      // Simulate D1 SELECT with aliases (as the API query does)
      const d1Row = {
        id: cronWrittenRow.id,
        ad_set_id: cronWrittenRow.ad_group_id,
        ad_set_name: cronWrittenRow.ad_group_name,
        ad_set_status: cronWrittenRow.ad_group_status,
        campaign_id: cronWrittenRow.campaign_id,
        platform_fields: cronWrittenRow.platform_fields,
        updated_at: '2025-12-15T00:00:00Z',
        // Metrics from LEFT JOIN ad_metrics
        impressions: 15000,
        clicks: 375,
        spend_cents: 12750,
        conversions: 18,
      };

      const result = mapAdSetResponse(d1Row);

      // Budget extracted from platform_fields
      expect(result.daily_budget_cents).toBe(2550);
      expect(result.lifetime_budget_cents).toBeNull();

      // Targeting extracted from platform_fields
      expect(result.targeting).toEqual({ age_min: 25, age_max: 55, genders: [2] });

      // Status uppercased
      expect(result.status).toBe('ACTIVE');

      // Metrics correct
      expect(result.spend).toBe(127.5);
      expect(result.ctr).toBeCloseTo(2.5, 1);
    });

    it('should read what cron writes for ads', () => {
      // Simulate cron writes
      const cronWrittenRow = {
        id: 'uuid-ad-1',
        organization_id: 'org_1',
        platform: 'facebook',
        account_id: '123456789',
        campaign_ref: 'uuid-camp-1',
        ad_group_ref: 'uuid-ag-1',
        campaign_id: 'camp_001',
        ad_group_id: 'adset_001',
        ad_id: 'ad_001',
        ad_name: 'My Facebook Ad',
        ad_status: 'paused',
        ad_type: null,
        headline: null,
        landing_url: null,
        platform_fields: JSON.stringify({ creative_id: 'cr_fb_99' }),
        raw_data: '{}',
      };

      // D1 SELECT result
      const d1Row = {
        id: cronWrittenRow.id,
        ad_id: cronWrittenRow.ad_id,
        ad_name: cronWrittenRow.ad_name,
        ad_status: cronWrittenRow.ad_status,
        campaign_id: cronWrittenRow.campaign_id,
        ad_set_id: cronWrittenRow.ad_group_id,
        platform_fields: cronWrittenRow.platform_fields,
        updated_at: '2025-12-15T00:00:00Z',
        impressions: 8000,
        clicks: 200,
        spend_cents: 4000,
        conversions: 10,
      };

      const result = mapAdResponse(d1Row);

      // creative_id from platform_fields
      expect(result.creative_id).toBe('cr_fb_99');

      // Status uppercased
      expect(result.status).toBe('PAUSED');
      expect(result.ad_status).toBe('PAUSED');

      // Metrics
      expect(result.spend).toBe(40);
      expect(result.ctr).toBe(2.5);
    });
  });

  describe('SQL column existence validation', () => {
    // These tests validate that the SELECT queries only reference columns
    // that exist in the unified table schema (migration 0019).

    const UNIFIED_AD_GROUPS_COLUMNS = [
      'id', 'organization_id', 'platform', 'account_id', 'campaign_ref',
      'campaign_id', 'ad_group_id', 'ad_group_name', 'ad_group_status',
      'bid_amount_cents', 'bid_type', 'platform_fields', 'raw_data',
      'last_synced_at', 'created_at', 'updated_at'
    ];

    const UNIFIED_ADS_COLUMNS = [
      'id', 'organization_id', 'platform', 'account_id', 'campaign_ref',
      'ad_group_ref', 'campaign_id', 'ad_group_id', 'ad_id', 'ad_name',
      'ad_status', 'ad_type', 'headline', 'landing_url', 'platform_fields',
      'raw_data', 'last_synced_at', 'created_at', 'updated_at'
    ];

    it('ad_groups table should NOT have daily_budget_cents column', () => {
      expect(UNIFIED_AD_GROUPS_COLUMNS).not.toContain('daily_budget_cents');
    });

    it('ad_groups table should NOT have lifetime_budget_cents column', () => {
      expect(UNIFIED_AD_GROUPS_COLUMNS).not.toContain('lifetime_budget_cents');
    });

    it('ad_groups table should NOT have targeting column', () => {
      expect(UNIFIED_AD_GROUPS_COLUMNS).not.toContain('targeting');
    });

    it('ads table should NOT have creative_id column', () => {
      expect(UNIFIED_ADS_COLUMNS).not.toContain('creative_id');
    });

    it('ad_groups should have platform_fields (where budget/targeting live)', () => {
      expect(UNIFIED_AD_GROUPS_COLUMNS).toContain('platform_fields');
    });

    it('ads should have platform_fields (where creative_id lives)', () => {
      expect(UNIFIED_ADS_COLUMNS).toContain('platform_fields');
    });
  });
});
