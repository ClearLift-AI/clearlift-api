/**
 * Metrics Fetcher
 *
 * Fetches and aggregates metrics from D1 ANALYTICS_DB for analysis.
 * Uses Sessions API for read replication support.
 */

import { Platform, EntityLevel } from './entity-tree';

// D1 types (D1Database, D1DatabaseSession, etc.) come from worker-configuration.d.ts

export interface TimeseriesMetric {
  date: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  conversions: number;
  conversion_value_cents: number;
}

export interface EnrichedMetric extends TimeseriesMetric {
  ctr: number;  // Click-through rate (%)
  cpc_cents: number;  // Cost per click
  cpm_cents: number;  // Cost per thousand impressions
  roas: number;  // Return on ad spend
  cpa_cents: number;  // Cost per acquisition
}

export interface DateRange {
  start: string;  // YYYY-MM-DD
  end: string;    // YYYY-MM-DD
}

export class MetricsFetcher {
  private session: D1DatabaseSession;

  constructor(db: D1Database) {
    // Use Sessions API for read replication support
    this.session = db.withSession('first-unconstrained');
  }

  /**
   * Fetch metrics for a specific entity from D1 ANALYTICS_DB
   */
  async fetchMetrics(
    platform: Platform,
    level: EntityLevel,
    entityId: string,
    dateRange: DateRange
  ): Promise<TimeseriesMetric[]> {
    const table = this.getMetricsTable(platform, level);
    const refColumn = this.getRefColumn(platform, level);

    if (!table || !refColumn) {
      return [];
    }

    try {
      const result = await this.session.prepare(`
        SELECT
          metric_date,
          COALESCE(impressions, 0) as impressions,
          COALESCE(clicks, 0) as clicks,
          COALESCE(spend_cents, 0) as spend_cents,
          COALESCE(conversions, 0) as conversions,
          COALESCE(conversion_value_cents, 0) as conversion_value_cents
        FROM ${table}
        WHERE ${refColumn} = ?
          AND metric_date >= ?
          AND metric_date <= ?
        ORDER BY metric_date ASC
      `).bind(entityId, dateRange.start, dateRange.end).all<{
        metric_date: string;
        impressions: number;
        clicks: number;
        spend_cents: number;
        conversions: number;
        conversion_value_cents: number;
      }>();

      return (result.results || []).map(r => ({
        date: r.metric_date,
        impressions: r.impressions || 0,
        clicks: r.clicks || 0,
        spend_cents: r.spend_cents || 0,
        conversions: r.conversions || 0,
        conversion_value_cents: r.conversion_value_cents || 0
      }));
    } catch (err) {
      console.error(`D1 metrics query failed for ${table}:`, err);
      return [];
    }
  }

  /**
   * Fetch aggregated metrics for a parent entity
   * Aggregates child metrics by date
   */
  async fetchAggregatedMetrics(
    platform: Platform,
    level: EntityLevel,
    childIds: string[],
    dateRange: DateRange
  ): Promise<TimeseriesMetric[]> {
    if (childIds.length === 0) {
      return [];
    }

    // For parent levels, we need to get the child level's metrics
    const childLevel = this.getChildLevel(level);
    if (!childLevel) {
      return [];
    }

    // Fetch metrics for all children
    const childMetrics = await Promise.all(
      childIds.map(id => this.fetchMetrics(platform, childLevel, id, dateRange))
    );

    // Aggregate by date
    const metricsByDate = new Map<string, TimeseriesMetric>();

    for (const metrics of childMetrics) {
      for (const m of metrics) {
        const existing = metricsByDate.get(m.date);
        if (existing) {
          existing.impressions += m.impressions;
          existing.clicks += m.clicks;
          existing.spend_cents += m.spend_cents;
          existing.conversions += m.conversions;
          existing.conversion_value_cents += m.conversion_value_cents;
        } else {
          metricsByDate.set(m.date, { ...m });
        }
      }
    }

    // Sort by date
    return Array.from(metricsByDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
  }

  /**
   * Calculate derived metrics (CTR, CPC, ROAS, etc.)
   */
  calculateDerivedMetrics(metrics: TimeseriesMetric[]): EnrichedMetric[] {
    return metrics.map(m => ({
      ...m,
      ctr: m.impressions > 0
        ? (m.clicks / m.impressions) * 100
        : 0,
      cpc_cents: m.clicks > 0
        ? Math.round(m.spend_cents / m.clicks)
        : 0,
      cpm_cents: m.impressions > 0
        ? Math.round((m.spend_cents / m.impressions) * 1000)
        : 0,
      roas: m.spend_cents > 0
        ? m.conversion_value_cents / m.spend_cents
        : 0,
      cpa_cents: m.conversions > 0
        ? Math.round(m.spend_cents / m.conversions)
        : 0
    }));
  }

  /**
   * Get metrics table name for platform/level (D1 ANALYTICS_DB)
   */
  private getMetricsTable(platform: Platform, level: EntityLevel): string | null {
    // All platforms now use unified ad_metrics table
    // Return 'ad_metrics' for all valid platform/level combinations
    const validLevels: Record<Platform, EntityLevel[]> = {
      google: ['ad', 'adset', 'campaign'],
      facebook: ['ad', 'adset', 'campaign'],
      tiktok: ['ad', 'adset', 'campaign']
    };

    if (level === 'account') return null; // Account level aggregates from campaigns
    if (!validLevels[platform]?.includes(level)) return null;

    return 'ad_metrics'; // All use unified table now
  }

  /**
   * Get entity_type value for unified ad_metrics table
   */
  private getEntityType(level: EntityLevel): string | null {
    const mapping: Record<EntityLevel, string | null> = {
      ad: 'ad',
      adset: 'ad_group', // Facebook ad_sets are unified as ad_groups
      campaign: 'campaign',
      account: null
    };
    return mapping[level] || null;
  }

  /**
   * Get reference column name for platform/level
   */
  private getRefColumn(platform: Platform, level: EntityLevel): string | null {
    const columns: Record<Platform, Record<EntityLevel, string | null>> = {
      google: {
        ad: 'ad_ref',
        adset: 'ad_group_ref',
        campaign: 'campaign_ref',
        account: null
      },
      facebook: {
        ad: 'ad_ref',
        adset: 'ad_set_ref',
        campaign: 'campaign_ref',
        account: null
      },
      tiktok: {
        ad: 'ad_ref',
        adset: 'ad_group_ref',
        campaign: 'campaign_ref',
        account: null
      }
    };

    return columns[platform]?.[level] || null;
  }

  /**
   * Get child level for a parent level
   */
  private getChildLevel(level: EntityLevel): EntityLevel | null {
    const childMap: Record<EntityLevel, EntityLevel | null> = {
      account: 'campaign',
      campaign: 'adset',
      adset: 'ad',
      ad: null
    };

    return childMap[level];
  }

  /**
   * Calculate total metrics for a date range
   */
  sumMetrics(metrics: TimeseriesMetric[]): TimeseriesMetric {
    return metrics.reduce(
      (sum, m) => ({
        date: 'total',
        impressions: sum.impressions + m.impressions,
        clicks: sum.clicks + m.clicks,
        spend_cents: sum.spend_cents + m.spend_cents,
        conversions: sum.conversions + m.conversions,
        conversion_value_cents: sum.conversion_value_cents + m.conversion_value_cents
      }),
      {
        date: 'total',
        impressions: 0,
        clicks: 0,
        spend_cents: 0,
        conversions: 0,
        conversion_value_cents: 0
      }
    );
  }
}
