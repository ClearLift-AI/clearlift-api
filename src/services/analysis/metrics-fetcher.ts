/**
 * Metrics Fetcher
 *
 * Fetches and aggregates metrics from D1 ANALYTICS_DB for analysis.
 * Uses Sessions API for read replication support.
 */

import { Platform, EntityLevel } from './entity-tree';
import { structuredLog } from '../../utils/structured-logger';

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
  /** Track silent query failures for diagnostics */
  failedQueries = 0;

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
    const entityType = this.getEntityType(level);

    if (!table || !entityType) {
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
        WHERE entity_ref = ?
          AND entity_type = ?
          AND platform = ?
          AND metric_date >= ?
          AND metric_date <= ?
        ORDER BY metric_date ASC
      `).bind(entityId, entityType, platform, dateRange.start, dateRange.end).all<{
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
      structuredLog('ERROR', 'D1 metrics query failed', {
        service: 'metrics-fetcher',
        table,
        entityId,
        entityType,
        platform,
        dateRange: `${dateRange.start}..${dateRange.end}`,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      this.failedQueries++;
      return [];
    }
  }

  /**
   * Fetch aggregated metrics for a parent entity
   * Aggregates child metrics by date, batched to avoid overwhelming D1
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

    // Batch D1 queries to avoid overwhelming the session with concurrent requests.
    // Previously this fired all childIds in a single Promise.all (e.g. 43+ concurrent
    // queries for an account with many campaigns), which caused silent failures.
    const BATCH_SIZE = 5;
    const failedBefore = this.failedQueries;
    const metricsByDate = new Map<string, TimeseriesMetric>();

    for (let i = 0; i < childIds.length; i += BATCH_SIZE) {
      const batch = childIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(id => this.fetchMetrics(platform, childLevel, id, dateRange))
      );

      for (const metrics of batchResults) {
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
    }

    const failedInThisCall = this.failedQueries - failedBefore;
    if (failedInThisCall > 0) {
      structuredLog('WARN', 'Aggregated metrics had D1 failures', {
        service: 'metrics-fetcher',
        platform,
        entityLevel: level,
        totalChildren: childIds.length,
        failedQueries: failedInThisCall,
        dateRange: `${dateRange.start}..${dateRange.end}`
      });
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
   * Map entity level to the entity_type discriminator value in ad_metrics
   */
  private getEntityType(level: EntityLevel): string | null {
    const typeMap: Record<EntityLevel, string | null> = {
      campaign: 'campaign',
      adset: 'ad_group',
      ad: 'ad',
      account: null
    };

    return typeMap[level] || null;
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
