/**
 * Jobber Revenue Source Provider
 *
 * Queries connector_events table for Jobber conversion and revenue data.
 * A conversion is an event with source_platform='jobber' and a completed status.
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
      SELECT 1 FROM connector_events
      WHERE organization_id = ? AND source_platform = 'jobber'
      LIMIT 1
    `).bind(orgId).first();
    return !!result;
  },

  async getSummary(db: D1Database, orgId: string, hours: number): Promise<RevenueSourceSummary> {
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_events,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN 1 ELSE 0 END) as paid_invoices,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN value_cents ELSE 0 END) as total_revenue_cents,
        COUNT(DISTINCT customer_external_id) as unique_clients
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'jobber'
        AND transacted_at >= datetime('now', '-' || ? || ' hours')
    `).bind(orgId, hours).first<{
      total_events: number;
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
    const result = await db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', transacted_at) as bucket,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN value_cents ELSE 0 END) as revenue_cents
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'jobber'
        AND transacted_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY strftime('%Y-%m-%d %H:00:00', transacted_at)
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

  async getSummaryByDateRange(db: D1Database, orgId: string, dateRange: DateRange): Promise<RevenueSourceSummary> {
    const result = await db.prepare(`
      SELECT
        COUNT(*) as total_events,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN 1 ELSE 0 END) as paid_invoices,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN value_cents ELSE 0 END) as total_revenue_cents,
        COUNT(DISTINCT customer_external_id) as unique_clients
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'jobber'
        AND DATE(transacted_at) >= ?
        AND DATE(transacted_at) <= ?
    `).bind(orgId, dateRange.start, dateRange.end).first<{
      total_events: number;
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
        DATE(transacted_at) as bucket,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN platform_status IN ('paid', 'completed', 'succeeded') THEN value_cents ELSE 0 END) as revenue_cents
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'jobber'
        AND DATE(transacted_at) >= ?
        AND DATE(transacted_at) <= ?
      GROUP BY DATE(transacted_at)
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
