/**
 * Stripe Revenue Source Provider
 *
 * Queries stripe_charges table for conversion and revenue data.
 * A conversion is a successful charge (status = 'succeeded').
 */

// D1Database is globally available in the Workers environment
import {
  RevenueSourceProvider,
  RevenueSourceMeta,
  RevenueSourceSummary,
  RevenueSourceTimeSeries,
  revenueSourceRegistry,
} from './index';

const meta: RevenueSourceMeta = {
  platform: 'stripe',
  displayName: 'Stripe Payments',
  conversionLabel: 'Charges',
  icon: 'credit-card',
};

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
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_charges,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as successful_charges,
        SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END) as total_revenue_cents,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM stripe_charges
      WHERE organization_id = ?
        AND stripe_created_at >= datetime('now', '-' || ? || ' hours')
    `).bind(orgId, hours).first<{
      total_charges: number;
      successful_charges: number;
      total_revenue_cents: number;
      unique_customers: number;
    }>();

    return {
      conversions: result?.successful_charges || 0,
      revenue: (result?.total_revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_customers || 0,
    };
  },

  async getTimeSeries(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceTimeSeries[]> {
    const result = await db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', stripe_created_at) as bucket,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END) as revenue_cents
      FROM stripe_charges
      WHERE organization_id = ?
        AND stripe_created_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY strftime('%Y-%m-%d %H:00:00', stripe_created_at)
      ORDER BY bucket ASC
    `).bind(orgId, hours).all<{
      bucket: string;
      conversions: number;
      revenue_cents: number;
    }>();

    return result.results.map((row: { bucket: string; conversions: number; revenue_cents: number }) => ({
      bucket: row.bucket,
      conversions: row.conversions,
      revenue: row.revenue_cents / 100,
    }));
  },
};

// Register the provider
revenueSourceRegistry.register(stripeProvider);

export default stripeProvider;
