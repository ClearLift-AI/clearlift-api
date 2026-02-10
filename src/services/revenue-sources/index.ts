/**
 * Revenue Source Plugin System
 *
 * Allows any connector to register itself as a revenue source for Real-Time analytics.
 * Each provider implements RevenueSourceProvider and handles its own query logic.
 */

import { structuredLog } from '../../utils/structured-logger';

// D1Database is globally available in the Workers environment

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Summary data returned by a revenue source
 */
export interface RevenueSourceSummary {
  conversions: number;
  revenue: number;
  uniqueCustomers: number;
}

/**
 * Time series data point
 */
export interface RevenueSourceTimeSeries {
  bucket: string;
  conversions: number;
  revenue: number;
}

/**
 * Metadata about a revenue source
 */
export interface RevenueSourceMeta {
  platform: string;           // 'stripe', 'shopify', 'jobber'
  displayName: string;        // 'Stripe Payments', 'Shopify Orders'
  conversionLabel: string;    // 'Charges', 'Orders', 'Jobs'
  icon?: string;              // Optional icon identifier
}

/**
 * Date range for queries
 */
export interface DateRange {
  start: string;  // YYYY-MM-DD
  end: string;    // YYYY-MM-DD
}

/**
 * Interface that all revenue source providers must implement
 */
export interface RevenueSourceProvider {
  /** Metadata about this revenue source */
  meta: RevenueSourceMeta;

  /**
   * Check if this revenue source has data for the given org
   * Used for auto-discovery of connected revenue sources
   */
  hasData(db: D1Database, orgId: string): Promise<boolean>;

  /**
   * Get summary metrics for the last N hours (real-time)
   */
  getSummary(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceSummary>;

  /**
   * Get hourly time series for charts (real-time)
   */
  getTimeSeries(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceTimeSeries[]>;

  /**
   * Get summary metrics for a date range (for reports/attribution)
   */
  getSummaryByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceSummary>;

  /**
   * Get daily time series for a date range (for reports/attribution)
   */
  getTimeSeriesByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceTimeSeries[]>;

  /**
   * Get MRR/ARR metrics for SaaS businesses (optional)
   * Only implemented by sources that support subscription data
   */
  getMRR?(db: D1Database, orgId: string): Promise<{
    mrr: number;           // Monthly Recurring Revenue in dollars
    arr: number;           // Annual Recurring Revenue in dollars
    activeSubscriptions: number;
    trialSubscriptions: number;
    churnedThisMonth: number;
  }>;
}

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Registry of all revenue source providers
 */
class RevenueSourceRegistry {
  private providers: Map<string, RevenueSourceProvider> = new Map();

  /**
   * Register a revenue source provider
   */
  register(provider: RevenueSourceProvider): void {
    this.providers.set(provider.meta.platform, provider);
  }

  /**
   * Get a provider by platform name
   */
  get(platform: string): RevenueSourceProvider | undefined {
    return this.providers.get(platform);
  }

  /**
   * Get all registered providers
   */
  getAll(): RevenueSourceProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all platforms that have data for this org
   */
  async getAvailableForOrg(
    db: D1Database,
    orgId: string,
    excludePlatforms: string[] = []
  ): Promise<RevenueSourceProvider[]> {
    const available: RevenueSourceProvider[] = [];

    for (const provider of this.providers.values()) {
      if (excludePlatforms.includes(provider.meta.platform)) {
        continue;
      }

      try {
        const hasData = await provider.hasData(db, orgId);
        if (hasData) {
          available.push(provider);
        }
      } catch (e) {
        // Provider's table may not exist, skip silently
      }
    }

    return available;
  }
}

// Singleton registry instance
export const revenueSourceRegistry = new RevenueSourceRegistry();

// =============================================================================
// COMBINED QUERY HELPER
// =============================================================================

export interface CombinedRevenueResult {
  summary: {
    conversions: number;
    revenue: number;
    uniqueCustomers: number;
    sources: Record<string, { conversions: number; revenue: number; displayName: string }>;
  };
  timeSeries: RevenueSourceTimeSeries[];
  availableSources: RevenueSourceMeta[];
}

/**
 * Query all available revenue sources and combine results
 */
export async function getCombinedRevenue(
  db: D1Database,
  orgId: string,
  hours: number,
  disabledPlatforms: string[] = []
): Promise<CombinedRevenueResult> {
  // Get all available providers for this org
  const providers = await revenueSourceRegistry.getAvailableForOrg(db, orgId, disabledPlatforms);

  // Initialize results
  const sources: CombinedRevenueResult['summary']['sources'] = {};
  let totalConversions = 0;
  let totalRevenue = 0;
  let totalCustomers = 0;
  const timeSeriesMap: Map<string, { conversions: number; revenue: number }> = new Map();

  // Query each provider in parallel
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const [summary, timeSeries] = await Promise.all([
          provider.getSummary(db, orgId, hours),
          provider.getTimeSeries(db, orgId, hours),
        ]);
        return { provider, summary, timeSeries };
      } catch (e) {
        structuredLog('ERROR', 'Revenue source query failed', { service: 'RevenueSource', platform: provider.meta.platform, error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    })
  );

  // Aggregate results
  for (const result of results) {
    if (!result) continue;

    const { provider, summary, timeSeries } = result;
    const platform = provider.meta.platform;

    // Add to sources breakdown
    sources[platform] = {
      conversions: summary.conversions,
      revenue: summary.revenue,
      displayName: provider.meta.displayName,
    };

    // Accumulate totals
    totalConversions += summary.conversions;
    totalRevenue += summary.revenue;
    totalCustomers += summary.uniqueCustomers;

    // Merge time series
    for (const point of timeSeries) {
      const existing = timeSeriesMap.get(point.bucket) || { conversions: 0, revenue: 0 };
      timeSeriesMap.set(point.bucket, {
        conversions: existing.conversions + point.conversions,
        revenue: existing.revenue + point.revenue,
      });
    }
  }

  // Convert time series map to sorted array
  const timeSeries = Array.from(timeSeriesMap.entries())
    .map(([bucket, data]) => ({ bucket, ...data }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    summary: {
      conversions: totalConversions,
      revenue: totalRevenue,
      uniqueCustomers: totalCustomers,
      sources,
    },
    timeSeries,
    availableSources: providers.map(p => p.meta),
  };
}

/**
 * Query all available revenue sources for a date range and combine results
 * Used by Journey Overview, Attribution, and other analytics endpoints
 */
export async function getCombinedRevenueByDateRange(
  db: D1Database,
  orgId: string,
  dateRange: DateRange,
  disabledPlatforms: string[] = []
): Promise<CombinedRevenueResult> {
  // Get all available providers for this org
  const providers = await revenueSourceRegistry.getAvailableForOrg(db, orgId, disabledPlatforms);

  // Initialize results
  const sources: CombinedRevenueResult['summary']['sources'] = {};
  let totalConversions = 0;
  let totalRevenue = 0;
  let totalCustomers = 0;
  const timeSeriesMap: Map<string, { conversions: number; revenue: number }> = new Map();

  // Query each provider in parallel
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const [summary, timeSeries] = await Promise.all([
          provider.getSummaryByDateRange(db, orgId, dateRange),
          provider.getTimeSeriesByDateRange(db, orgId, dateRange),
        ]);
        return { provider, summary, timeSeries };
      } catch (e) {
        structuredLog('ERROR', 'Revenue source date range query failed', { service: 'RevenueSource', platform: provider.meta.platform, error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    })
  );

  // Aggregate results
  for (const result of results) {
    if (!result) continue;

    const { provider, summary, timeSeries } = result;
    const platform = provider.meta.platform;

    // Add to sources breakdown
    sources[platform] = {
      conversions: summary.conversions,
      revenue: summary.revenue,
      displayName: provider.meta.displayName,
    };

    // Accumulate totals
    totalConversions += summary.conversions;
    totalRevenue += summary.revenue;
    totalCustomers += summary.uniqueCustomers;

    // Merge time series (daily buckets)
    for (const point of timeSeries) {
      const existing = timeSeriesMap.get(point.bucket) || { conversions: 0, revenue: 0 };
      timeSeriesMap.set(point.bucket, {
        conversions: existing.conversions + point.conversions,
        revenue: existing.revenue + point.revenue,
      });
    }
  }

  // Convert time series map to sorted array
  const timeSeries = Array.from(timeSeriesMap.entries())
    .map(([bucket, data]) => ({ bucket, ...data }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    summary: {
      conversions: totalConversions,
      revenue: totalRevenue,
      uniqueCustomers: totalCustomers,
      sources,
    },
    timeSeries,
    availableSources: providers.map(p => p.meta),
  };
}
