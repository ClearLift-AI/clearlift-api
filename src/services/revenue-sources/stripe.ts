/**
 * Stripe Revenue Source Provider
 *
 * Queries connector_events table for Stripe conversion and revenue data.
 *
 * CONVERSION LOGIC:
 * - Conversions are events that made it past incomplete/incomplete_expired status.
 *   What matters is the sign-up date (transacted_at) and that the subscription/charge
 *   succeeded — not its current status.
 * - platform_status IN ('succeeded', 'paid', 'active') covers both charges and subscriptions.
 * - Subscription renewals are excluded from conversion count via event_type filtering
 *   but still contribute to revenue.
 *
 * REVENUE LOGIC:
 * - All succeeded/active events contribute to revenue via value_cents.
 */

// D1Database is globally available in the Workers environment
import {
  RevenueSourceProvider,
  RevenueSourceMeta,
  RevenueSourceSummary,
  RevenueSourceTimeSeries,
  DateRange,
  revenueSourceRegistry,
} from './index';

const meta: RevenueSourceMeta = {
  platform: 'stripe',
  displayName: 'Stripe Payments',
  conversionLabel: 'Charges',
  icon: 'credit-card',
};

/**
 * SQL fragment for counting conversions from connector_events.
 * Only counts new acquisitions — excludes subscription renewals (event_type = 'subscription_cycle').
 */
const CONVERSION_COUNT_SQL = `
  SUM(CASE
    WHEN platform_status IN ('succeeded', 'paid', 'active')
      AND (event_type IS NULL OR event_type != 'subscription_cycle')
    THEN 1 ELSE 0
  END)
`;

/**
 * SQL fragment for calculating net revenue (all succeeded/active events)
 */
const NET_REVENUE_SQL = `
  SUM(CASE
    WHEN platform_status IN ('succeeded', 'paid', 'active')
    THEN COALESCE(value_cents, 0)
    ELSE 0
  END)
`;

const stripeProvider: RevenueSourceProvider = {
  meta,

  async hasData(db: D1Database, orgId: string): Promise<boolean> {
    const result = await db.prepare(`
      SELECT 1 FROM connector_events
      WHERE organization_id = ? AND source_platform = 'stripe'
      LIMIT 1
    `).bind(orgId).first();
    return !!result;
  },

  async getSummary(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceSummary> {
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_charges,
        ${CONVERSION_COUNT_SQL} as conversions,
        ${NET_REVENUE_SQL} as net_revenue_cents,
        COUNT(DISTINCT customer_external_id) as unique_customers
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'stripe'
        AND transacted_at >= datetime('now', '-' || ? || ' hours')
    `).bind(orgId, hours).first<{
      total_charges: number;
      conversions: number;
      net_revenue_cents: number;
      unique_customers: number;
    }>();

    return {
      conversions: result?.conversions || 0,
      revenue: (result?.net_revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_customers || 0,
    };
  },

  async getTimeSeries(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceTimeSeries[]> {
    const result = await db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', transacted_at) as bucket,
        ${CONVERSION_COUNT_SQL} as conversions,
        ${NET_REVENUE_SQL} as net_revenue_cents
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'stripe'
        AND transacted_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY strftime('%Y-%m-%d %H:00:00', transacted_at)
      ORDER BY bucket ASC
    `).bind(orgId, hours).all<{
      bucket: string;
      conversions: number;
      net_revenue_cents: number;
    }>();

    return result.results.map((row: { bucket: string; conversions: number; net_revenue_cents: number }) => ({
      bucket: row.bucket,
      conversions: row.conversions,
      revenue: row.net_revenue_cents / 100,
    }));
  },

  async getSummaryByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceSummary> {
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_charges,
        ${CONVERSION_COUNT_SQL} as conversions,
        ${NET_REVENUE_SQL} as net_revenue_cents,
        COUNT(DISTINCT customer_external_id) as unique_customers
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'stripe'
        AND DATE(transacted_at) >= ?
        AND DATE(transacted_at) <= ?
    `).bind(orgId, dateRange.start, dateRange.end).first<{
      total_charges: number;
      conversions: number;
      net_revenue_cents: number;
      unique_customers: number;
    }>();

    return {
      conversions: result?.conversions || 0,
      revenue: (result?.net_revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_customers || 0,
    };
  },

  async getTimeSeriesByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceTimeSeries[]> {
    const result = await db.prepare(`
      SELECT
        DATE(transacted_at) as bucket,
        ${CONVERSION_COUNT_SQL} as conversions,
        ${NET_REVENUE_SQL} as net_revenue_cents
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'stripe'
        AND DATE(transacted_at) >= ?
        AND DATE(transacted_at) <= ?
      GROUP BY DATE(transacted_at)
      ORDER BY bucket ASC
    `).bind(orgId, dateRange.start, dateRange.end).all<{
      bucket: string;
      conversions: number;
      net_revenue_cents: number;
    }>();

    return result.results.map((row: { bucket: string; conversions: number; net_revenue_cents: number }) => ({
      bucket: row.bucket,
      conversions: row.conversions,
      revenue: row.net_revenue_cents / 100,
    }));
  },

  /**
   * Get MRR/ARR metrics from Stripe subscription events.
   * Queries connector_events for subscription-type events to approximate MRR.
   */
  async getMRR(db: D1Database, orgId: string): Promise<{
    mrr: number;
    arr: number;
    activeSubscriptions: number;
    trialSubscriptions: number;
    churnedThisMonth: number;
  }> {
    // Get active subscription events (latest per customer)
    const activeResult = await db.prepare(`
      SELECT
        COUNT(CASE WHEN platform_status IN ('active', 'trialing') THEN 1 END) as active_count,
        COUNT(CASE WHEN platform_status = 'trialing' THEN 1 END) as trial_count,
        COALESCE(SUM(CASE WHEN platform_status = 'active' THEN value_cents ELSE 0 END), 0) as mrr_cents
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'stripe'
        AND event_type LIKE '%subscription%'
        AND platform_status IN ('active', 'trialing')
    `).bind(orgId).first<{
      active_count: number;
      trial_count: number;
      mrr_cents: number;
    }>();

    // Get churned subscriptions this month
    const churnedResult = await db.prepare(`
      SELECT COUNT(*) as churned
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'stripe'
        AND event_type LIKE '%subscription%'
        AND platform_status IN ('canceled', 'cancelled', 'unpaid')
        AND transacted_at >= date('now', 'start of month')
    `).bind(orgId).first<{ churned: number }>();

    const mrrCents = activeResult?.mrr_cents || 0;
    const mrr = Math.round(mrrCents) / 100;
    const arr = mrr * 12;

    return {
      mrr,
      arr,
      activeSubscriptions: activeResult?.active_count || 0,
      trialSubscriptions: activeResult?.trial_count || 0,
      churnedThisMonth: churnedResult?.churned || 0,
    };
  },
};

// Register the provider
revenueSourceRegistry.register(stripeProvider);

export default stripeProvider;
