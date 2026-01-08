/**
 * Dual-Write Adapter
 *
 * Writes platform data to both Supabase (primary) and D1 shards (shadow).
 * Used during migration period to ensure D1 has complete data.
 *
 * Behavior:
 * - Always writes to Supabase first (current source of truth)
 * - Attempts write to D1 shard in parallel
 * - Logs discrepancies but doesn't fail on D1 errors
 * - Can be toggled per-organization or globally
 *
 * @example
 * ```typescript
 * const adapter = new DualWriteAdapter(supabase, router, { enabled: true });
 * await adapter.upsertCampaign('google', orgId, campaignData);
 * ```
 */

import { SupabaseClient } from './supabase';
import { ShardRouter } from './shard-router';
import { v4 as uuid } from 'uuid';

export interface DualWriteConfig {
  enabled: boolean;
  logDiscrepancies: boolean;
  failOnD1Error: boolean;  // If true, throw on D1 errors (useful for testing)
}

const DEFAULT_CONFIG: DualWriteConfig = {
  enabled: true,
  logDiscrepancies: true,
  failOnD1Error: false,
};

export interface CampaignData {
  id?: string;
  organization_id: string;
  customer_id?: string;  // Google
  account_id?: string;   // Facebook
  advertiser_id?: string; // TikTok
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  campaign_type?: string;
  objective?: string;
  budget_amount_cents?: number;
  budget_type?: string;
  bidding_strategy_type?: string;
  bid_strategy?: string;
  target_cpa_cents?: number;
  target_roas?: number;
  raw_data?: unknown;
  last_synced_at?: string;
}

export interface MetricsData {
  id?: string;
  organization_id: string;
  campaign_ref?: string;
  ad_group_ref?: string;
  ad_set_ref?: string;
  ad_ref?: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  conversions: number;
  conversion_value_cents: number;
  video_views?: number;
  reach?: number;
}

type Platform = 'google' | 'facebook' | 'tiktok';
type EntityLevel = 'campaign' | 'ad_group' | 'ad_set' | 'ad';

export class DualWriteAdapter {
  private config: DualWriteConfig;

  constructor(
    private supabase: SupabaseClient,
    private router: ShardRouter,
    config: Partial<DualWriteConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the table name for D1 based on platform and entity
   */
  private getD1TableName(platform: Platform, entity: EntityLevel | 'metrics'): string {
    const tables: Record<Platform, Record<string, string>> = {
      google: {
        campaign: 'google_campaigns',
        ad_group: 'google_ad_groups',
        ad: 'google_ads',
        campaign_metrics: 'google_campaign_metrics',
        ad_group_metrics: 'google_ad_group_metrics',
        ad_metrics: 'google_ad_metrics',
      },
      facebook: {
        campaign: 'facebook_campaigns',
        ad_set: 'facebook_ad_sets',
        ad: 'facebook_ads',
        campaign_metrics: 'facebook_campaign_metrics',
        ad_set_metrics: 'facebook_ad_set_metrics',
        ad_metrics: 'facebook_ad_metrics',
      },
      tiktok: {
        campaign: 'tiktok_campaigns',
        ad_group: 'tiktok_ad_groups',
        ad: 'tiktok_ads',
        campaign_metrics: 'tiktok_campaign_metrics',
        ad_group_metrics: 'tiktok_ad_group_metrics',
        ad_metrics: 'tiktok_ad_metrics',
      },
    };
    return tables[platform][entity] || `${platform}_${entity}`;
  }

  /**
   * Get the Supabase schema name for a platform
   */
  private getSupabaseSchema(platform: Platform): string {
    return `${platform}_ads`;
  }

  /**
   * Upsert a campaign to both databases
   */
  async upsertCampaign(
    platform: Platform,
    data: CampaignData
  ): Promise<{ supabaseSuccess: boolean; d1Success: boolean; errors: string[] }> {
    const errors: string[] = [];
    let supabaseSuccess = false;
    let d1Success = false;

    const id = data.id || uuid();
    const now = new Date().toISOString();

    // Prepare Supabase data
    const supabaseData = {
      ...data,
      id,
      updated_at: now,
      last_synced_at: data.last_synced_at || now,
    };

    // Write to Supabase first
    try {
      await this.supabase.upsertWithSchema(
        'campaigns',
        supabaseData,
        this.getConflictKey(platform, 'campaign'),
        this.getSupabaseSchema(platform),
        false
      );
      supabaseSuccess = true;
    } catch (e) {
      const msg = `Supabase write failed: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      console.error('[DualWrite] ' + msg);
    }

    // Write to D1 shard if enabled
    if (this.config.enabled && this.router.isEnabled()) {
      try {
        const shard = await this.router.getShardForOrg(data.organization_id);
        const table = this.getD1TableName(platform, 'campaign');

        // Build INSERT OR REPLACE for SQLite
        await shard.prepare(`
          INSERT OR REPLACE INTO ${table} (
            id, organization_id, ${this.getAccountIdColumn(platform)}, campaign_id,
            campaign_name, campaign_status, ${platform === 'google' ? 'campaign_type' : 'objective'},
            budget_amount_cents, budget_type,
            ${platform === 'google' ? 'bidding_strategy_type' : 'bid_strategy'},
            raw_data, created_at, updated_at, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
        `).bind(
          id,
          data.organization_id,
          data.customer_id || data.account_id || data.advertiser_id,
          data.campaign_id,
          data.campaign_name,
          data.campaign_status,
          data.campaign_type || data.objective || null,
          data.budget_amount_cents || null,
          data.budget_type || null,
          data.bidding_strategy_type || data.bid_strategy || null,
          data.raw_data ? JSON.stringify(data.raw_data) : null,
          data.last_synced_at || now
        ).run();

        d1Success = true;
      } catch (e) {
        const msg = `D1 write failed: ${e instanceof Error ? e.message : String(e)}`;
        errors.push(msg);
        if (this.config.logDiscrepancies) {
          console.error('[DualWrite] ' + msg);
        }
        if (this.config.failOnD1Error) {
          throw new Error(msg);
        }
      }
    }

    return { supabaseSuccess, d1Success, errors };
  }

  /**
   * Upsert metrics to both databases
   */
  async upsertMetrics(
    platform: Platform,
    level: EntityLevel,
    data: MetricsData[]
  ): Promise<{ supabaseSuccess: boolean; d1Success: boolean; errors: string[] }> {
    const errors: string[] = [];
    let supabaseSuccess = false;
    let d1Success = false;

    if (data.length === 0) {
      return { supabaseSuccess: true, d1Success: true, errors: [] };
    }

    const orgId = data[0].organization_id;
    const now = new Date().toISOString();

    // Prepare data with IDs
    const metricsWithIds = data.map(m => ({
      ...m,
      id: m.id || uuid(),
      created_at: now,
      updated_at: now,
    }));

    // Write to Supabase
    try {
      const tableName = `${level === 'ad_set' ? 'ad_set' : level}_daily_metrics`;
      await this.supabase.upsertWithSchema(
        tableName,
        metricsWithIds,
        this.getMetricsConflictKey(platform, level),
        this.getSupabaseSchema(platform),
        false
      );
      supabaseSuccess = true;
    } catch (e) {
      const msg = `Supabase metrics write failed: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      console.error('[DualWrite] ' + msg);
    }

    // Write to D1
    if (this.config.enabled && this.router.isEnabled()) {
      try {
        const shard = await this.router.getShardForOrg(orgId);
        const table = this.getD1TableName(platform, `${level}_metrics` as EntityLevel);
        const refColumn = this.getRefColumn(level);

        // Batch insert for efficiency
        const statements = metricsWithIds.map(m =>
          shard.prepare(`
            INSERT OR REPLACE INTO ${table} (
              id, ${refColumn}, organization_id, metric_date,
              impressions, clicks, spend_cents, conversions, conversion_value_cents,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          `).bind(
            m.id,
            m.campaign_ref || m.ad_group_ref || m.ad_set_ref || m.ad_ref,
            m.organization_id,
            m.metric_date,
            m.impressions,
            m.clicks,
            m.spend_cents,
            m.conversions,
            m.conversion_value_cents
          )
        );

        await shard.batch(statements);
        d1Success = true;
      } catch (e) {
        const msg = `D1 metrics write failed: ${e instanceof Error ? e.message : String(e)}`;
        errors.push(msg);
        if (this.config.logDiscrepancies) {
          console.error('[DualWrite] ' + msg);
        }
        if (this.config.failOnD1Error) {
          throw new Error(msg);
        }
      }
    }

    return { supabaseSuccess, d1Success, errors };
  }

  /**
   * Batch upsert campaigns
   */
  async batchUpsertCampaigns(
    platform: Platform,
    campaigns: CampaignData[]
  ): Promise<{ supabaseSuccess: boolean; d1Success: boolean; errors: string[] }> {
    const errors: string[] = [];
    let supabaseSuccess = false;
    let d1Success = false;

    if (campaigns.length === 0) {
      return { supabaseSuccess: true, d1Success: true, errors: [] };
    }

    // Write to Supabase in batch
    try {
      const now = new Date().toISOString();
      const dataWithIds = campaigns.map(c => ({
        ...c,
        id: c.id || uuid(),
        updated_at: now,
        last_synced_at: c.last_synced_at || now,
      }));

      await this.supabase.upsertWithSchema(
        'campaigns',
        dataWithIds,
        this.getConflictKey(platform, 'campaign'),
        this.getSupabaseSchema(platform),
        false
      );
      supabaseSuccess = true;
    } catch (e) {
      const msg = `Supabase batch write failed: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      console.error('[DualWrite] ' + msg);
    }

    // Write to D1 per-org (campaigns might span multiple orgs)
    if (this.config.enabled && this.router.isEnabled()) {
      // Group by org
      const byOrg = new Map<string, CampaignData[]>();
      for (const campaign of campaigns) {
        const existing = byOrg.get(campaign.organization_id) || [];
        existing.push(campaign);
        byOrg.set(campaign.organization_id, existing);
      }

      let allD1Success = true;
      for (const [orgId, orgCampaigns] of byOrg) {
        try {
          const shard = await this.router.getShardForOrg(orgId);
          const table = this.getD1TableName(platform, 'campaign');
          const now = new Date().toISOString();

          const statements = orgCampaigns.map(c => {
            const id = c.id || uuid();
            return shard.prepare(`
              INSERT OR REPLACE INTO ${table} (
                id, organization_id, ${this.getAccountIdColumn(platform)}, campaign_id,
                campaign_name, campaign_status, ${platform === 'google' ? 'campaign_type' : 'objective'},
                budget_amount_cents, budget_type, raw_data,
                created_at, updated_at, last_synced_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
            `).bind(
              id,
              c.organization_id,
              c.customer_id || c.account_id || c.advertiser_id,
              c.campaign_id,
              c.campaign_name,
              c.campaign_status,
              c.campaign_type || c.objective || null,
              c.budget_amount_cents || null,
              c.budget_type || null,
              c.raw_data ? JSON.stringify(c.raw_data) : null,
              c.last_synced_at || now
            );
          });

          await shard.batch(statements);
        } catch (e) {
          allD1Success = false;
          const msg = `D1 batch write failed for org ${orgId}: ${e instanceof Error ? e.message : String(e)}`;
          errors.push(msg);
          if (this.config.logDiscrepancies) {
            console.error('[DualWrite] ' + msg);
          }
        }
      }
      d1Success = allD1Success;
    }

    return { supabaseSuccess, d1Success, errors };
  }

  private getAccountIdColumn(platform: Platform): string {
    switch (platform) {
      case 'google': return 'customer_id';
      case 'facebook': return 'account_id';
      case 'tiktok': return 'advertiser_id';
    }
  }

  private getConflictKey(platform: Platform, entity: EntityLevel): string {
    switch (platform) {
      case 'google':
        return 'organization_id,customer_id,campaign_id';
      case 'facebook':
        return 'organization_id,account_id,campaign_id';
      case 'tiktok':
        return 'organization_id,advertiser_id,campaign_id';
    }
  }

  private getMetricsConflictKey(platform: Platform, level: EntityLevel): string {
    const refColumn = this.getRefColumn(level);
    return `organization_id,${refColumn},metric_date`;
  }

  private getRefColumn(level: EntityLevel): string {
    switch (level) {
      case 'campaign': return 'campaign_ref';
      case 'ad_group': return 'ad_group_ref';
      case 'ad_set': return 'ad_set_ref';
      case 'ad': return 'ad_ref';
    }
  }
}
