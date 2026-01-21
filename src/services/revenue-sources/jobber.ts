/**
 * Jobber Revenue Source Provider
 *
 * Queries jobber_invoices table for conversion and revenue data.
 * A conversion is a paid invoice (status = 'paid' or is_paid = 1).
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
  platform: 'jobber',
  displayName: 'Jobber Invoices',
  conversionLabel: 'Paid Invoices',
  icon: 'briefcase',
};

const jobberProvider: RevenueSourceProvider = {
  meta,

  async hasData(db: D1Database, orgId: string): Promise<boolean> {
    const result = await db.prepare(`
      SELECT 1 FROM jobber_invoices
      WHERE organization_id = ?
      LIMIT 1
    `).bind(orgId).first();
    return !!result;
  },

  async getSummary(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceSummary> {
    // Query invoices paid in the last N hours
    // Use paid_at if available, otherwise fall back to jobber_created_at
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_invoices,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN 1 ELSE 0 END) as paid_invoices,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN total_cents ELSE 0 END) as total_revenue_cents,
        COUNT(DISTINCT client_id) as unique_clients
      FROM jobber_invoices
      WHERE organization_id = ?
        AND (
          (paid_at IS NOT NULL AND paid_at >= datetime('now', '-' || ? || ' hours'))
          OR (paid_at IS NULL AND jobber_created_at >= datetime('now', '-' || ? || ' hours'))
        )
    `).bind(orgId, hours, hours).first<{
      total_invoices: number;
      paid_invoices: number;
      total_revenue_cents: number;
      unique_clients: number;
    }>();

    return {
      conversions: result?.paid_invoices || 0,
      revenue: (result?.total_revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_clients || 0,
    };
  },

  async getTimeSeries(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceTimeSeries[]> {
    // Group by hour based on paid_at or jobber_created_at
    const result = await db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', COALESCE(paid_at, jobber_created_at)) as bucket,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN total_cents ELSE 0 END) as revenue_cents
      FROM jobber_invoices
      WHERE organization_id = ?
        AND (
          (paid_at IS NOT NULL AND paid_at >= datetime('now', '-' || ? || ' hours'))
          OR (paid_at IS NULL AND jobber_created_at >= datetime('now', '-' || ? || ' hours'))
        )
      GROUP BY strftime('%Y-%m-%d %H:00:00', COALESCE(paid_at, jobber_created_at))
      ORDER BY bucket ASC
    `).bind(orgId, hours, hours).all<{
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

  async getSummaryByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceSummary> {
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_invoices,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN 1 ELSE 0 END) as paid_invoices,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN total_cents ELSE 0 END) as total_revenue_cents,
        COUNT(DISTINCT client_id) as unique_clients
      FROM jobber_invoices
      WHERE organization_id = ?
        AND date(COALESCE(paid_at, jobber_created_at)) >= ?
        AND date(COALESCE(paid_at, jobber_created_at)) <= ?
    `).bind(orgId, dateRange.start, dateRange.end).first<{
      total_invoices: number;
      paid_invoices: number;
      total_revenue_cents: number;
      unique_clients: number;
    }>();

    return {
      conversions: result?.paid_invoices || 0,
      revenue: (result?.total_revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_clients || 0,
    };
  },

  async getTimeSeriesByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceTimeSeries[]> {
    const result = await db.prepare(`
      SELECT
        date(COALESCE(paid_at, jobber_created_at)) as bucket,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN is_paid = 1 OR status = 'paid' THEN total_cents ELSE 0 END) as revenue_cents
      FROM jobber_invoices
      WHERE organization_id = ?
        AND date(COALESCE(paid_at, jobber_created_at)) >= ?
        AND date(COALESCE(paid_at, jobber_created_at)) <= ?
      GROUP BY date(COALESCE(paid_at, jobber_created_at))
      ORDER BY bucket ASC
    `).bind(orgId, dateRange.start, dateRange.end).all<{
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
revenueSourceRegistry.register(jobberProvider);

export default jobberProvider;
