/**
 * Aggregation Service
 *
 * Computes pre-aggregated summaries from raw metrics data in D1 shards.
 * Runs nightly via cron to populate:
 * - org_daily_summary: Daily totals per org per platform
 * - campaign_period_summary: Rolling period aggregates (7d, 30d, 90d)
 * - platform_comparison: Cross-platform comparison data
 * - org_timeseries: Daily timeseries for charts
 *
 * Design:
 * - Processes each shard independently (parallelizable)
 * - Uses SQL aggregations (SUM, COUNT, GROUP BY) - no client-side compute
 * - Idempotent: Can be re-run safely (INSERT OR REPLACE)
 * - Tracks job status for monitoring
 */

// D1Database type comes from worker-configuration.d.ts

import { structuredLog } from '../utils/structured-logger';

export interface AggregationResult {
  shardId: number;
  success: boolean;
  orgDailySummary: { orgs: number; rows: number };
  campaignSummary: { campaigns: number; rows: number };
  platformComparison: { orgs: number; rows: number };
  timeseries: { orgs: number; rows: number };
  duration_ms: number;
  error?: string;
}

export interface AggregationJobResult {
  success: boolean;
  shards: AggregationResult[];
  totalDuration_ms: number;
  errors: string[];
}

type Platform = 'google' | 'facebook' | 'tiktok';

export class AggregationService {
  private analyticsDb?: D1Database;

  constructor(private shards: D1Database[], analyticsDb?: D1Database) {
    this.analyticsDb = analyticsDb;
  }

  /**
   * Run aggregation across all shards
   */
  async runFullAggregation(targetDate?: string): Promise<AggregationJobResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const results: AggregationResult[] = [];

    // Default to yesterday
    const date = targetDate || this.getYesterday();

    console.log(`[Aggregation] Starting full aggregation for ${date} across ${this.shards.length} shards`);

    // Process shards in parallel
    const shardResults = await Promise.allSettled(
      this.shards.map((shard, idx) => this.aggregateShard(shard, idx, date))
    );

    for (let i = 0; i < shardResults.length; i++) {
      const result = shardResults[i];
      if (result.status === 'fulfilled') {
        results.push(result.value);
        if (!result.value.success) {
          errors.push(`Shard ${i}: ${result.value.error}`);
        }
      } else {
        errors.push(`Shard ${i}: ${result.reason}`);
        results.push({
          shardId: i,
          success: false,
          orgDailySummary: { orgs: 0, rows: 0 },
          campaignSummary: { campaigns: 0, rows: 0 },
          platformComparison: { orgs: 0, rows: 0 },
          timeseries: { orgs: 0, rows: 0 },
          duration_ms: 0,
          error: String(result.reason),
        });
      }
    }

    // Also run connector revenue aggregation from ANALYTICS_DB if available
    if (this.analyticsDb) {
      try {
        const connectorResult = await this.aggregateConnectorFromAnalyticsDb(date);
        console.log(`[Aggregation] Connector revenue aggregation: ${connectorResult.charges} events processed`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        errors.push(`ANALYTICS_DB connector revenue: ${error}`);
        structuredLog('ERROR', 'Connector revenue aggregation failed', { service: 'aggregation', step: 'connector_revenue', error });
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[Aggregation] Completed in ${totalDuration}ms with ${errors.length} errors`);

    return {
      success: errors.length === 0,
      shards: results,
      totalDuration_ms: totalDuration,
      errors,
    };
  }

  /**
   * Aggregate a single shard
   */
  async aggregateShard(shard: D1Database, shardId: number, date: string): Promise<AggregationResult> {
    const startTime = Date.now();
    console.log(`[Aggregation] Processing shard ${shardId} for date ${date}`);

    try {
      // 1. Aggregate org_daily_summary for each platform
      const orgDailyResult = await this.aggregateOrgDailySummary(shard, date);

      // 2. Aggregate campaign_period_summary (7d, 30d, 90d)
      const campaignResult = await this.aggregateCampaignPeriodSummary(shard, date);

      // 3. Aggregate platform_comparison
      const comparisonResult = await this.aggregatePlatformComparison(shard, date);

      // 4. Aggregate org_timeseries
      const timeseriesResult = await this.aggregateOrgTimeseries(shard, date);

      // 5. Update aggregation job tracking
      await this.updateJobTracking(shard, date);

      return {
        shardId,
        success: true,
        orgDailySummary: orgDailyResult,
        campaignSummary: campaignResult,
        platformComparison: comparisonResult,
        timeseries: timeseriesResult,
        duration_ms: Date.now() - startTime,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      structuredLog('ERROR', 'Shard aggregation failed', { service: 'aggregation', shard_id: shardId, error });
      return {
        shardId,
        success: false,
        orgDailySummary: { orgs: 0, rows: 0 },
        campaignSummary: { campaigns: 0, rows: 0 },
        platformComparison: { orgs: 0, rows: 0 },
        timeseries: { orgs: 0, rows: 0 },
        duration_ms: Date.now() - startTime,
        error,
      };
    }
  }

  /**
   * Aggregate org_daily_summary for all platforms
   */
  private async aggregateOrgDailySummary(
    shard: D1Database,
    date: string
  ): Promise<{ orgs: number; rows: number }> {
    let totalOrgs = 0;
    let totalRows = 0;

    for (const platform of ['google', 'facebook', 'tiktok'] as Platform[]) {
      const result = await this.aggregateOrgDailySummaryForPlatform(shard, platform, date);
      totalOrgs += result.orgs;
      totalRows += result.rows;
    }

    // Also aggregate connector revenue
    await this.aggregateConnectorDailySummary(shard, date);

    return { orgs: totalOrgs, rows: totalRows };
  }

  /**
   * Aggregate org_daily_summary for a specific platform
   * Uses unified ad_campaigns and ad_metrics tables
   */
  private async aggregateOrgDailySummaryForPlatform(
    shard: D1Database,
    platform: Platform,
    date: string
  ): Promise<{ orgs: number; rows: number }> {
    // Query unified tables with platform filter
    const result = await shard.prepare(`
      INSERT OR REPLACE INTO org_daily_summary (
        id, organization_id, platform, metric_date,
        total_spend_cents, total_impressions, total_clicks,
        total_conversions, total_conversion_value_cents,
        active_campaigns, active_ad_groups, active_ads,
        ctr, cpc_cents, cpm_cents, roas, cpa_cents,
        updated_at
      )
      SELECT
        c.organization_id || ':' || c.platform || ':' || ? as id,
        c.organization_id,
        c.platform,
        ? as metric_date,
        COALESCE(SUM(m.spend_cents), 0) as total_spend_cents,
        COALESCE(SUM(m.impressions), 0) as total_impressions,
        COALESCE(SUM(m.clicks), 0) as total_clicks,
        COALESCE(SUM(m.conversions), 0) as total_conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as total_conversion_value_cents,
        COUNT(DISTINCT CASE WHEN c.campaign_status = 'active' THEN c.id END) as active_campaigns,
        0 as active_ad_groups,
        0 as active_ads,
        CASE WHEN SUM(m.impressions) > 0
          THEN CAST(SUM(m.clicks) AS REAL) / SUM(m.impressions)
          ELSE 0
        END as ctr,
        CASE WHEN SUM(m.clicks) > 0
          THEN CAST(SUM(m.spend_cents) AS INTEGER) / SUM(m.clicks)
          ELSE 0
        END as cpc_cents,
        CASE WHEN SUM(m.impressions) > 0
          THEN CAST(SUM(m.spend_cents) * 1000 AS INTEGER) / SUM(m.impressions)
          ELSE 0
        END as cpm_cents,
        CASE WHEN SUM(m.spend_cents) > 0
          THEN CAST(SUM(m.conversion_value_cents) AS REAL) / SUM(m.spend_cents)
          ELSE 0
        END as roas,
        CASE WHEN SUM(m.conversions) > 0
          THEN CAST(SUM(m.spend_cents) AS INTEGER) / SUM(m.conversions)
          ELSE 0
        END as cpa_cents,
        datetime('now') as updated_at
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date = ?
      WHERE c.platform = ?
      GROUP BY c.organization_id
      HAVING SUM(m.spend_cents) > 0 OR COUNT(DISTINCT c.id) > 0
    `).bind(date, date, date, platform).run();

    return {
      orgs: result.meta?.changes || 0,
      rows: result.meta?.changes || 0,
    };
  }

  /**
   * Aggregate connector revenue daily summary (Stripe, Shopify, Jobber, etc.)
   */
  private async aggregateConnectorDailySummary(shard: D1Database, date: string): Promise<void> {
    await shard.prepare(`
      INSERT OR REPLACE INTO org_daily_summary (
        id, organization_id, platform, metric_date,
        total_spend_cents, total_impressions, total_clicks,
        total_conversions, total_conversion_value_cents,
        active_campaigns, total_revenue_cents, total_charges,
        updated_at
      )
      SELECT
        organization_id || ':' || source_platform || ':' || ? as id,
        organization_id,
        source_platform as platform,
        ? as metric_date,
        0 as total_spend_cents,
        0 as total_impressions,
        0 as total_clicks,
        COUNT(*) as total_conversions,
        COALESCE(SUM(value_cents), 0) as total_conversion_value_cents,
        0 as active_campaigns,
        COALESCE(SUM(value_cents), 0) as total_revenue_cents,
        COUNT(*) as total_charges,
        datetime('now') as updated_at
      FROM connector_events
      WHERE DATE(transacted_at) = ?
        AND platform_status IN ('succeeded', 'paid', 'completed', 'active')
      GROUP BY organization_id, source_platform
    `).bind(date, date, date).run();
  }

  /**
   * Aggregate campaign_period_summary for rolling periods
   */
  private async aggregateCampaignPeriodSummary(
    shard: D1Database,
    date: string
  ): Promise<{ campaigns: number; rows: number }> {
    let totalCampaigns = 0;
    let totalRows = 0;

    const periods = [
      { type: '7d', days: 7 },
      { type: '30d', days: 30 },
      { type: '90d', days: 90 },
    ];

    for (const platform of ['google', 'facebook', 'tiktok'] as Platform[]) {
      for (const period of periods) {
        const result = await this.aggregateCampaignPeriodForPlatform(
          shard, platform, date, period.type, period.days
        );
        totalCampaigns += result.campaigns;
        totalRows += result.rows;
      }
    }

    return { campaigns: totalCampaigns, rows: totalRows };
  }

  /**
   * Aggregate campaign_period_summary for a specific platform and period
   * Uses unified ad_campaigns and ad_metrics tables
   */
  private async aggregateCampaignPeriodForPlatform(
    shard: D1Database,
    platform: Platform,
    endDate: string,
    periodType: string,
    periodDays: number
  ): Promise<{ campaigns: number; rows: number }> {
    const startDate = this.subtractDays(endDate, periodDays - 1);

    const result = await shard.prepare(`
      INSERT OR REPLACE INTO campaign_period_summary (
        id, organization_id, platform, campaign_id, campaign_ref,
        campaign_name, campaign_status, period_type, period_start, period_end,
        total_spend_cents, total_impressions, total_clicks,
        total_conversions, total_conversion_value_cents,
        ctr, cpc_cents, cpm_cents, roas, cpa_cents,
        budget_cents, budget_utilization_pct,
        updated_at
      )
      SELECT
        c.organization_id || ':' || c.platform || ':' || c.campaign_id || ':' || ? as id,
        c.organization_id,
        c.platform,
        c.campaign_id,
        c.id as campaign_ref,
        c.campaign_name,
        c.campaign_status,
        ? as period_type,
        ? as period_start,
        ? as period_end,
        COALESCE(SUM(m.spend_cents), 0) as total_spend_cents,
        COALESCE(SUM(m.impressions), 0) as total_impressions,
        COALESCE(SUM(m.clicks), 0) as total_clicks,
        COALESCE(SUM(m.conversions), 0) as total_conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as total_conversion_value_cents,
        CASE WHEN SUM(m.impressions) > 0
          THEN CAST(SUM(m.clicks) AS REAL) / SUM(m.impressions)
          ELSE 0
        END as ctr,
        CASE WHEN SUM(m.clicks) > 0
          THEN CAST(SUM(m.spend_cents) AS INTEGER) / SUM(m.clicks)
          ELSE 0
        END as cpc_cents,
        CASE WHEN SUM(m.impressions) > 0
          THEN CAST(SUM(m.spend_cents) * 1000 AS INTEGER) / SUM(m.impressions)
          ELSE 0
        END as cpm_cents,
        CASE WHEN SUM(m.spend_cents) > 0
          THEN CAST(SUM(m.conversion_value_cents) AS REAL) / SUM(m.spend_cents)
          ELSE 0
        END as roas,
        CASE WHEN SUM(m.conversions) > 0
          THEN CAST(SUM(m.spend_cents) AS INTEGER) / SUM(m.conversions)
          ELSE 0
        END as cpa_cents,
        c.budget_cents,
        CASE WHEN c.budget_cents > 0 AND c.budget_cents IS NOT NULL
          THEN CAST(SUM(m.spend_cents) AS REAL) / (c.budget_cents * ?) * 100
          ELSE 0
        END as budget_utilization_pct,
        datetime('now') as updated_at
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.platform = ?
      GROUP BY c.id
    `).bind(periodType, periodType, startDate, endDate, periodDays, startDate, endDate, platform).run();

    return {
      campaigns: result.meta?.changes || 0,
      rows: result.meta?.changes || 0,
    };
  }

  /**
   * Aggregate platform_comparison for cross-platform dashboard
   */
  private async aggregatePlatformComparison(
    shard: D1Database,
    date: string
  ): Promise<{ orgs: number; rows: number }> {
    let totalRows = 0;

    for (const periodDays of [7, 30, 90]) {
      const startDate = this.subtractDays(date, periodDays - 1);

      const result = await shard.prepare(`
        INSERT OR REPLACE INTO platform_comparison (
          id, organization_id, comparison_date, period_days,
          google_spend_cents, google_impressions, google_clicks,
          google_conversions, google_conversion_value_cents, google_roas, google_ctr, google_cpc_cents,
          facebook_spend_cents, facebook_impressions, facebook_clicks,
          facebook_conversions, facebook_conversion_value_cents, facebook_roas, facebook_ctr, facebook_cpc_cents,
          tiktok_spend_cents, tiktok_impressions, tiktok_clicks,
          tiktok_conversions, tiktok_conversion_value_cents, tiktok_roas, tiktok_ctr, tiktok_cpc_cents,
          stripe_revenue_cents, stripe_charges,
          total_spend_cents, total_impressions, total_clicks,
          total_conversions, total_conversion_value_cents,
          blended_roas, blended_ctr, blended_cpc_cents,
          updated_at
        )
        SELECT
          s.organization_id || ':' || ? || ':' || ? as id,
          s.organization_id,
          ? as comparison_date,
          ? as period_days,
          -- Google
          SUM(CASE WHEN s.platform = 'google' THEN s.total_spend_cents ELSE 0 END),
          SUM(CASE WHEN s.platform = 'google' THEN s.total_impressions ELSE 0 END),
          SUM(CASE WHEN s.platform = 'google' THEN s.total_clicks ELSE 0 END),
          SUM(CASE WHEN s.platform = 'google' THEN s.total_conversions ELSE 0 END),
          SUM(CASE WHEN s.platform = 'google' THEN s.total_conversion_value_cents ELSE 0 END),
          CASE WHEN SUM(CASE WHEN s.platform = 'google' THEN s.total_spend_cents ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform = 'google' THEN s.total_conversion_value_cents ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform = 'google' THEN s.total_spend_cents ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform = 'google' THEN s.total_impressions ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform = 'google' THEN s.total_clicks ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform = 'google' THEN s.total_impressions ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform = 'google' THEN s.total_clicks ELSE 0 END) > 0
            THEN SUM(CASE WHEN s.platform = 'google' THEN s.total_spend_cents ELSE 0 END)
                 / SUM(CASE WHEN s.platform = 'google' THEN s.total_clicks ELSE 0 END)
            ELSE 0
          END,
          -- Facebook
          SUM(CASE WHEN s.platform = 'facebook' THEN s.total_spend_cents ELSE 0 END),
          SUM(CASE WHEN s.platform = 'facebook' THEN s.total_impressions ELSE 0 END),
          SUM(CASE WHEN s.platform = 'facebook' THEN s.total_clicks ELSE 0 END),
          SUM(CASE WHEN s.platform = 'facebook' THEN s.total_conversions ELSE 0 END),
          SUM(CASE WHEN s.platform = 'facebook' THEN s.total_conversion_value_cents ELSE 0 END),
          CASE WHEN SUM(CASE WHEN s.platform = 'facebook' THEN s.total_spend_cents ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform = 'facebook' THEN s.total_conversion_value_cents ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform = 'facebook' THEN s.total_spend_cents ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform = 'facebook' THEN s.total_impressions ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform = 'facebook' THEN s.total_clicks ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform = 'facebook' THEN s.total_impressions ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform = 'facebook' THEN s.total_clicks ELSE 0 END) > 0
            THEN SUM(CASE WHEN s.platform = 'facebook' THEN s.total_spend_cents ELSE 0 END)
                 / SUM(CASE WHEN s.platform = 'facebook' THEN s.total_clicks ELSE 0 END)
            ELSE 0
          END,
          -- TikTok
          SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_spend_cents ELSE 0 END),
          SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_impressions ELSE 0 END),
          SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_clicks ELSE 0 END),
          SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_conversions ELSE 0 END),
          SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_conversion_value_cents ELSE 0 END),
          CASE WHEN SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_spend_cents ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_conversion_value_cents ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_spend_cents ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_impressions ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_clicks ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_impressions ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_clicks ELSE 0 END) > 0
            THEN SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_spend_cents ELSE 0 END)
                 / SUM(CASE WHEN s.platform = 'tiktok' THEN s.total_clicks ELSE 0 END)
            ELSE 0
          END,
          -- Stripe
          SUM(CASE WHEN s.platform = 'stripe' THEN s.total_revenue_cents ELSE 0 END),
          SUM(CASE WHEN s.platform = 'stripe' THEN s.total_charges ELSE 0 END),
          -- Totals
          SUM(CASE WHEN s.platform != 'stripe' THEN s.total_spend_cents ELSE 0 END),
          SUM(CASE WHEN s.platform != 'stripe' THEN s.total_impressions ELSE 0 END),
          SUM(CASE WHEN s.platform != 'stripe' THEN s.total_clicks ELSE 0 END),
          SUM(CASE WHEN s.platform != 'stripe' THEN s.total_conversions ELSE 0 END),
          SUM(CASE WHEN s.platform != 'stripe' THEN s.total_conversion_value_cents ELSE 0 END),
          -- Blended metrics
          CASE WHEN SUM(CASE WHEN s.platform != 'stripe' THEN s.total_spend_cents ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform != 'stripe' THEN s.total_conversion_value_cents ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform != 'stripe' THEN s.total_spend_cents ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform != 'stripe' THEN s.total_impressions ELSE 0 END) > 0
            THEN CAST(SUM(CASE WHEN s.platform != 'stripe' THEN s.total_clicks ELSE 0 END) AS REAL)
                 / SUM(CASE WHEN s.platform != 'stripe' THEN s.total_impressions ELSE 0 END)
            ELSE 0
          END,
          CASE WHEN SUM(CASE WHEN s.platform != 'stripe' THEN s.total_clicks ELSE 0 END) > 0
            THEN SUM(CASE WHEN s.platform != 'stripe' THEN s.total_spend_cents ELSE 0 END)
                 / SUM(CASE WHEN s.platform != 'stripe' THEN s.total_clicks ELSE 0 END)
            ELSE 0
          END,
          datetime('now')
        FROM org_daily_summary s
        WHERE s.metric_date >= ?
          AND s.metric_date <= ?
        GROUP BY s.organization_id
      `).bind(date, periodDays, date, periodDays, startDate, date).run();

      totalRows += result.meta?.changes || 0;
    }

    return { orgs: totalRows, rows: totalRows };
  }

  /**
   * Aggregate org_timeseries for charts
   */
  private async aggregateOrgTimeseries(
    shard: D1Database,
    date: string
  ): Promise<{ orgs: number; rows: number }> {
    const result = await shard.prepare(`
      INSERT OR REPLACE INTO org_timeseries (
        id, organization_id, metric_date,
        total_spend_cents, total_impressions, total_clicks,
        total_conversions, total_revenue_cents,
        blended_roas, blended_ctr,
        updated_at
      )
      SELECT
        organization_id || ':' || ? as id,
        organization_id,
        ? as metric_date,
        SUM(CASE WHEN platform != 'stripe' THEN total_spend_cents ELSE 0 END),
        SUM(CASE WHEN platform != 'stripe' THEN total_impressions ELSE 0 END),
        SUM(CASE WHEN platform != 'stripe' THEN total_clicks ELSE 0 END),
        SUM(CASE WHEN platform != 'stripe' THEN total_conversions ELSE 0 END),
        SUM(CASE WHEN platform = 'stripe' THEN total_revenue_cents ELSE 0 END),
        CASE WHEN SUM(CASE WHEN platform != 'stripe' THEN total_spend_cents ELSE 0 END) > 0
          THEN CAST(SUM(CASE WHEN platform != 'stripe' THEN total_conversion_value_cents ELSE 0 END) AS REAL)
               / SUM(CASE WHEN platform != 'stripe' THEN total_spend_cents ELSE 0 END)
          ELSE 0
        END,
        CASE WHEN SUM(CASE WHEN platform != 'stripe' THEN total_impressions ELSE 0 END) > 0
          THEN CAST(SUM(CASE WHEN platform != 'stripe' THEN total_clicks ELSE 0 END) AS REAL)
               / SUM(CASE WHEN platform != 'stripe' THEN total_impressions ELSE 0 END)
          ELSE 0
        END,
        datetime('now')
      FROM org_daily_summary
      WHERE metric_date = ?
      GROUP BY organization_id
    `).bind(date, date, date).run();

    return {
      orgs: result.meta?.changes || 0,
      rows: result.meta?.changes || 0,
    };
  }

  /**
   * Update aggregation job tracking
   */
  private async updateJobTracking(shard: D1Database, date: string): Promise<void> {
    // Get list of orgs in this shard
    const orgs = await shard.prepare(`
      SELECT DISTINCT organization_id FROM org_daily_summary WHERE metric_date = ?
    `).bind(date).all<{ organization_id: string }>();

    for (const org of orgs.results) {
      await shard.prepare(`
        INSERT OR REPLACE INTO aggregation_jobs (
          id, organization_id, job_type, last_run_at, last_success_at,
          updated_at
        ) VALUES (
          ? || ':daily_aggregation',
          ?,
          'daily_aggregation',
          datetime('now'),
          datetime('now'),
          datetime('now')
        )
      `).bind(org.organization_id, org.organization_id).run();
    }
  }

  /**
   * Aggregate connector revenue from ANALYTICS_DB connector_events
   * into org_daily_summary. CAC/conversion data comes from cac_history + conversions.
   */
  async aggregateConnectorFromAnalyticsDb(date: string): Promise<{ charges: number; orgs: number }> {
    if (!this.analyticsDb) {
      return { charges: 0, orgs: 0 };
    }

    structuredLog('INFO', 'Aggregating connector revenue from ANALYTICS_DB', { service: 'aggregation', date });

    // Count connector events for the date as a health check
    const result = await this.analyticsDb.prepare(`
      SELECT COUNT(*) as total
      FROM connector_events
      WHERE DATE(transacted_at) = ?
        AND platform_status IN ('succeeded', 'paid', 'completed', 'active')
    `).bind(date).first<{ total: number }>();

    const total = result?.total || 0;
    structuredLog('INFO', 'Connector events aggregated', { service: 'aggregation', date, total });

    return { charges: total, orgs: total > 0 ? 1 : 0 };
  }

  /**
   * Get yesterday's date in YYYY-MM-DD format
   */
  private getYesterday(): string {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return date.toISOString().split('T')[0];
  }

  /**
   * Subtract days from a date string
   */
  private subtractDays(dateStr: string, days: number): string {
    const date = new Date(dateStr);
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
  }
}
