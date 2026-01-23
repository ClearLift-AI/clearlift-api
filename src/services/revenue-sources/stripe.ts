/**
 * Stripe Revenue Source Provider
 *
 * Queries stripe_charges table for conversion and revenue data.
 *
 * CONVERSION LOGIC (automatically handles both e-commerce and SaaS):
 * - E-commerce: All succeeded charges count as conversions (billing_reason IS NULL)
 * - SaaS: Only new subscriptions count as conversions (billing_reason = 'subscription_create')
 *   Renewals (billing_reason = 'subscription_cycle') are NOT conversions but DO contribute to revenue
 *
 * REVENUE LOGIC:
 * - All succeeded charges contribute to revenue (including renewals)
 * - Net revenue = amount_cents - refund_cents
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
 * SQL fragment for counting conversions
 * Only counts new acquisitions:
 * - One-time charges (billing_reason IS NULL)
 * - New subscriptions (billing_reason = 'subscription_create')
 * Excludes renewals (billing_reason = 'subscription_cycle')
 *
 * Status can be:
 * - 'succeeded' for charge objects
 * - 'active' for subscription data stored in charges table
 */
const CONVERSION_COUNT_SQL = `
  SUM(CASE
    WHEN status IN ('succeeded', 'active')
      AND (billing_reason IS NULL OR billing_reason = 'subscription_create')
    THEN 1 ELSE 0
  END)
`;

/**
 * SQL fragment for calculating net revenue (all succeeded/active charges)
 * Accepts both charge status 'succeeded' and subscription status 'active'
 */
const NET_REVENUE_SQL = `
  SUM(CASE
    WHEN status IN ('succeeded', 'active')
    THEN amount_cents - COALESCE(refund_cents, 0)
    ELSE 0
  END)
`;

const stripeProvider: RevenueSourceProvider = {
  meta,

  async hasData(db: D1Database, orgId: string): Promise<boolean> {
    const result = await db.prepare(`
      SELECT 1 FROM stripe_charges
      WHERE organization_id = ?
      LIMIT 1
    `).bind(orgId).first();
    return !!result;
  },

  async getSummary(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceSummary> {
    // Note: stripe_created_at is stored as ISO format (2026-01-22T16:14:37.000Z)
    // We need to convert it to SQLite datetime format for comparison
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_charges,
        ${CONVERSION_COUNT_SQL} as conversions,
        ${NET_REVENUE_SQL} as net_revenue_cents,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM stripe_charges
      WHERE organization_id = ?
        AND datetime(replace(replace(stripe_created_at, 'T', ' '), 'Z', '')) >= datetime('now', '-' || ? || ' hours')
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
    // Note: stripe_created_at is stored as ISO format, convert for comparison and grouping
    const result = await db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', datetime(replace(replace(stripe_created_at, 'T', ' '), 'Z', ''))) as bucket,
        ${CONVERSION_COUNT_SQL} as conversions,
        ${NET_REVENUE_SQL} as net_revenue_cents
      FROM stripe_charges
      WHERE organization_id = ?
        AND datetime(replace(replace(stripe_created_at, 'T', ' '), 'Z', '')) >= datetime('now', '-' || ? || ' hours')
      GROUP BY strftime('%Y-%m-%d %H:00:00', datetime(replace(replace(stripe_created_at, 'T', ' '), 'Z', '')))
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
        COUNT(DISTINCT customer_id) as unique_customers
      FROM stripe_charges
      WHERE organization_id = ?
        AND date(stripe_created_at) >= ?
        AND date(stripe_created_at) <= ?
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
        date(stripe_created_at) as bucket,
        ${CONVERSION_COUNT_SQL} as conversions,
        ${NET_REVENUE_SQL} as net_revenue_cents
      FROM stripe_charges
      WHERE organization_id = ?
        AND date(stripe_created_at) >= ?
        AND date(stripe_created_at) <= ?
      GROUP BY date(stripe_created_at)
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
   * Get MRR/ARR metrics from Stripe subscriptions
   * MRR is calculated by normalizing all active subscriptions to monthly values
   */
  async getMRR(db: D1Database, orgId: string): Promise<{
    mrr: number;
    arr: number;
    activeSubscriptions: number;
    trialSubscriptions: number;
    churnedThisMonth: number;
  }> {
    // Get active subscriptions and calculate MRR
    const activeResult = await db.prepare(`
      SELECT
        plan_amount_cents,
        plan_interval,
        plan_interval_count,
        status
      FROM stripe_subscriptions
      WHERE organization_id = ?
        AND status IN ('active', 'trialing')
    `).bind(orgId).all<{
      plan_amount_cents: number;
      plan_interval: string;
      plan_interval_count: number;
      status: string;
    }>();

    // Calculate MRR by normalizing all intervals to monthly
    let mrrCents = 0;
    let activeSubscriptions = 0;
    let trialSubscriptions = 0;

    for (const sub of activeResult.results || []) {
      const intervalCount = sub.plan_interval_count || 1;
      let monthlyAmount = sub.plan_amount_cents;

      // Normalize to monthly
      switch (sub.plan_interval) {
        case 'year':
          monthlyAmount = sub.plan_amount_cents / (12 * intervalCount);
          break;
        case 'week':
          monthlyAmount = (sub.plan_amount_cents * 52) / (12 * intervalCount);
          break;
        case 'day':
          monthlyAmount = (sub.plan_amount_cents * 365) / (12 * intervalCount);
          break;
        case 'month':
        default:
          monthlyAmount = sub.plan_amount_cents / intervalCount;
          break;
      }

      if (sub.status === 'active') {
        mrrCents += monthlyAmount;
        activeSubscriptions++;
      } else if (sub.status === 'trialing') {
        trialSubscriptions++;
        // Don't count trial subscriptions in MRR until they convert
      }
    }

    // Get churned subscriptions this month
    const churnedResult = await db.prepare(`
      SELECT COUNT(*) as churned
      FROM stripe_subscriptions
      WHERE organization_id = ?
        AND status IN ('canceled', 'unpaid')
        AND canceled_at >= date('now', 'start of month')
    `).bind(orgId).first<{ churned: number }>();

    const mrr = Math.round(mrrCents) / 100;  // Convert to dollars
    const arr = mrr * 12;

    return {
      mrr,
      arr,
      activeSubscriptions,
      trialSubscriptions,
      churnedThisMonth: churnedResult?.churned || 0,
    };
  },
};

// Register the provider
revenueSourceRegistry.register(stripeProvider);

export default stripeProvider;
