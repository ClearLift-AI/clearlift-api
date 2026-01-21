/**
 * Shopify Revenue Source Provider
 *
 * Queries shopify_orders table for conversion and revenue data.
 * A conversion is a paid order (financial_status = 'paid').
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
  platform: 'shopify',
  displayName: 'Shopify Orders',
  conversionLabel: 'Orders',
  icon: 'shopping-bag',
};

const shopifyProvider: RevenueSourceProvider = {
  meta,

  async hasData(db: D1Database, orgId: string): Promise<boolean> {
    const result = await db.prepare(`
      SELECT 1 FROM shopify_orders
      WHERE organization_id = ?
      LIMIT 1
    `).bind(orgId).first();
    return !!result;
  },

  async getSummary(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceSummary> {
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) as paid_orders,
        SUM(CASE WHEN financial_status = 'paid' THEN total_price_cents - COALESCE(refund_cents, 0) ELSE 0 END) as net_revenue_cents,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM shopify_orders
      WHERE organization_id = ?
        AND shopify_created_at >= datetime('now', '-' || ? || ' hours')
    `).bind(orgId, hours).first<{
      total_orders: number;
      paid_orders: number;
      net_revenue_cents: number;
      unique_customers: number;
    }>();

    return {
      conversions: result?.paid_orders || 0,
      revenue: (result?.net_revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_customers || 0,
    };
  },

  async getTimeSeries(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceTimeSeries[]> {
    const result = await db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', shopify_created_at) as bucket,
        SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN financial_status = 'paid' THEN total_price_cents - COALESCE(refund_cents, 0) ELSE 0 END) as net_revenue_cents
      FROM shopify_orders
      WHERE organization_id = ?
        AND shopify_created_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY strftime('%Y-%m-%d %H:00:00', shopify_created_at)
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
        COUNT(*) as total_orders,
        SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) as paid_orders,
        SUM(CASE WHEN financial_status = 'paid' THEN total_price_cents - COALESCE(refund_cents, 0) ELSE 0 END) as net_revenue_cents,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM shopify_orders
      WHERE organization_id = ?
        AND date(shopify_created_at) >= ?
        AND date(shopify_created_at) <= ?
    `).bind(orgId, dateRange.start, dateRange.end).first<{
      total_orders: number;
      paid_orders: number;
      net_revenue_cents: number;
      unique_customers: number;
    }>();

    return {
      conversions: result?.paid_orders || 0,
      revenue: (result?.net_revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_customers || 0,
    };
  },

  async getTimeSeriesByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceTimeSeries[]> {
    const result = await db.prepare(`
      SELECT
        date(shopify_created_at) as bucket,
        SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN financial_status = 'paid' THEN total_price_cents - COALESCE(refund_cents, 0) ELSE 0 END) as net_revenue_cents
      FROM shopify_orders
      WHERE organization_id = ?
        AND date(shopify_created_at) >= ?
        AND date(shopify_created_at) <= ?
      GROUP BY date(shopify_created_at)
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
};

// Register the provider
revenueSourceRegistry.register(shopifyProvider);

export default shopifyProvider;
