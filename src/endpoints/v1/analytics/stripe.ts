/**
 * Stripe Analytics Endpoint
 *
 * Retrieve and analyze Stripe revenue data from D1 ANALYTICS_DB
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1AnalyticsService } from "../../../services/d1-analytics";

/**
 * GET /v1/analytics/stripe
 * Get Stripe analytics with metadata filtering
 */
export class GetStripeAnalytics extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get Stripe revenue analytics",
    description: "Retrieve Stripe revenue data with optional metadata filtering and grouping",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        connection_id: z.string(),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        group_by: z.enum(['day', 'week', 'month']).optional().default('day'),

        // Metadata filtering
        metadata_filters: z.string().optional(), // JSON string of filters

        // Grouping options
        group_by_metadata: z.string().optional(), // Comma-separated metadata keys

        // Standard filters
        status: z.enum(['succeeded', 'pending', 'failed']).optional(),
        currency: z.string().length(3).optional(),
        min_amount: z.coerce.number().optional(),
        max_amount: z.coerce.number().optional(),

        // Pagination
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Stripe analytics data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                summary: z.object({
                  total_revenue: z.number(),
                  total_units: z.number(),
                  transaction_count: z.number(),
                  unique_customers: z.number(),
                  average_order_value: z.number()
                }),
                time_series: z.array(z.object({
                  date: z.string(),
                  revenue: z.number(),
                  units: z.number(),
                  transactions: z.number()
                })),
                by_product: z.record(z.number()).optional(),
                by_metadata: z.record(z.record(z.number())).optional(),
                metadata_keys_available: z.object({
                  charge: z.array(z.string()),
                  product: z.array(z.string()),
                  price: z.array(z.string()),
                  customer: z.array(z.string())
                }).optional()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();

    // Verify connection exists and user has access
    const connection = await c.env.DB.prepare(`
      SELECT pc.*, pc.organization_id
      FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND pc.platform = 'stripe' AND om.user_id = ?
    `).bind(query.query.connection_id, session.user_id).first<{ id: string; organization_id: string }>();

    if (!connection) {
      return error(c, "NOT_FOUND", "Stripe connection not found or access denied", 404);
    }

    // Use D1 ANALYTICS_DB
    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    const d1Analytics = new D1AnalyticsService(c.env.ANALYTICS_DB);

    try {
      // Get charges from D1
      const charges = await d1Analytics.getStripeCharges(
        connection.organization_id,
        query.query.connection_id,
        query.query.date_from,
        query.query.date_to,
        {
          status: query.query.status,
          currency: query.query.currency,
          minAmount: query.query.min_amount,
          maxAmount: query.query.max_amount,
          limit: 1000, // Get all for aggregation
          offset: 0,
        }
      );

      if (charges.length === 0) {
        return success(c, {
          summary: {
            total_revenue: 0,
            total_units: 0,
            transaction_count: 0,
            unique_customers: 0,
            average_order_value: 0
          },
          time_series: [],
          by_product: {},
          records: [],
          total_records: 0,
          sync_status: "No data synced yet. Please wait for the sync to complete."
        });
      }

      // Transform charges to records format
      const records = charges.map(charge => ({
        date: charge.stripe_created_at.split('T')[0],
        charge_id: charge.charge_id,
        amount: charge.amount_cents,
        currency: charge.currency,
        status: charge.status,
        customer_id: charge.customer_id,
        metadata: charge.metadata ? JSON.parse(charge.metadata) : {}
      }));

      // Calculate summary metrics
      const summary = this.calculateSummary(records);

      // Generate time series based on group_by
      const timeSeries = this.generateTimeSeries(
        records,
        query.query.group_by || 'day'
      );

      // Apply pagination
      const paginatedRecords = records.slice(
        query.query.offset || 0,
        (query.query.offset || 0) + (query.query.limit || 100)
      );

      return success(c, {
        summary,
        time_series: timeSeries,
        records: paginatedRecords.map(r => ({
          date: r.date,
          charge_id: r.charge_id,
          amount: r.amount / 100, // Convert cents to dollars
          currency: r.currency,
          status: r.status
        })),
        total_records: records.length
      });
    } catch (err) {
      console.error("D1 Stripe query failed:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch Stripe data", 500);
    }
  }

  private calculateSummary(records: any[]): any {
    // For charges: status === 'succeeded'
    // For subscriptions: status in ('active', 'trialing', 'past_due') - active billing relationships
    const successfulStatuses = ['succeeded', 'active', 'trialing', 'past_due'];
    const successfulRecords = records.filter(r => successfulStatuses.includes(r.status));
    const customerSet = new Set(records.map(r => r.customer_id).filter(Boolean));

    const totalRevenue = successfulRecords.reduce((sum, r) => sum + r.amount, 0);
    const totalUnits = successfulRecords.reduce((sum, r) => sum + (r.units || 1), 0);
    const transactionCount = successfulRecords.length;

    return {
      total_revenue: totalRevenue / 100, // Convert from cents
      total_units: totalUnits,
      transaction_count: transactionCount,
      unique_customers: customerSet.size,
      average_order_value: transactionCount > 0 ? (totalRevenue / transactionCount) / 100 : 0
    };
  }

  private generateTimeSeries(
    records: any[],
    groupBy: 'day' | 'week' | 'month'
  ): any[] {
    const grouped: Record<string, { revenue: number; units: number; transactions: number }> = {};
    const successfulStatuses = ['succeeded', 'active', 'trialing', 'past_due'];

    for (const record of records) {
      if (!successfulStatuses.includes(record.status)) continue;

      const date = this.getGroupedDate(record.date, groupBy);

      if (!grouped[date]) {
        grouped[date] = { revenue: 0, units: 0, transactions: 0 };
      }

      grouped[date].revenue += record.amount;
      grouped[date].units += record.units || 1;
      grouped[date].transactions += 1;
    }

    return Object.entries(grouped)
      .map(([date, data]) => ({
        date,
        revenue: data.revenue / 100,
        units: data.units,
        transactions: data.transactions
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private getGroupedDate(date: string, groupBy: 'day' | 'week' | 'month'): string {
    const d = new Date(date);

    switch (groupBy) {
      case 'week':
        // Get Monday of the week
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        return d.toISOString().split('T')[0];

      case 'month':
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

      default:
        return date;
    }
  }

  private groupByProduct(records: any[]): Record<string, number> {
    const grouped: Record<string, number> = {};

    for (const record of records) {
      if (record.status !== 'succeeded' || !record.product_id) continue;
      grouped[record.product_id] = (grouped[record.product_id] || 0) + record.amount;
    }

    // Convert to dollars
    for (const key in grouped) {
      grouped[key] = grouped[key] / 100;
    }

    return grouped;
  }

  private groupByMetadata(
    records: any[],
    metadataKeys: string[]
  ): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};

    for (const key of metadataKeys) {
      const [source, ...pathParts] = key.split('.');
      const metadataKey = pathParts.join('.');
      const groupKey = `${source}.${metadataKey}`;
      result[groupKey] = {};

      for (const record of records) {
        if (record.status !== 'succeeded') continue;

        const metadataField = `${source}_metadata`;
        let metadata = record[metadataField];

        if (!metadata) continue;

        try {
          if (typeof metadata === 'string') {
            metadata = JSON.parse(metadata);
          }

          const value = this.getNestedValue(metadata, metadataKey);
          if (value !== undefined) {
            const strValue = String(value);
            result[groupKey][strValue] = (result[groupKey][strValue] || 0) + record.amount / 100;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    return result;
  }

  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }

    return current;
  }
}

/**
 * GET /v1/analytics/stripe/daily-aggregates
 * Get pre-computed daily aggregates for better performance
 */
export class GetStripeDailyAggregates extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get Stripe daily aggregates",
    description: "Retrieve pre-computed daily aggregates for Stripe revenue",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        connection_id: z.string(),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        currency: z.string().length(3).optional()
      })
    },
    responses: {
      "200": {
        description: "Daily aggregate data"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();

    // Verify access and get org_id
    const connection = await c.env.DB.prepare(`
      SELECT pc.organization_id FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND pc.platform = 'stripe' AND om.user_id = ?
    `).bind(query.query.connection_id, session.user_id).first<{ organization_id: string }>();

    if (!connection) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Use D1 ANALYTICS_DB
    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    const d1Analytics = new D1AnalyticsService(c.env.ANALYTICS_DB);

    try {
      // Get time series data from D1
      const timeSeries = await d1Analytics.getStripeTimeSeries(
        connection.organization_id,
        query.query.connection_id,
        query.query.date_from,
        query.query.date_to,
        'day'
      );

      // Format as daily aggregates
      const formattedAggregates = timeSeries.map(row => ({
        date: row.date,
        currency: query.query.currency || 'usd',
        total_revenue: row.revenue,
        total_units: row.transactions,
        transaction_count: row.transactions,
        unique_customers: row.unique_customers
      }));

      // Calculate totals
      const totals = formattedAggregates.reduce((sum, day) => ({
        total_revenue: sum.total_revenue + day.total_revenue,
        total_units: sum.total_units + day.total_units,
        transaction_count: sum.transaction_count + day.transaction_count,
        unique_customers: Math.max(sum.unique_customers, day.unique_customers)
      }), {
        total_revenue: 0,
        total_units: 0,
        transaction_count: 0,
        unique_customers: 0
      });

      return success(c, {
        aggregates: formattedAggregates,
        totals,
        days: formattedAggregates.length
      });
    } catch (err) {
      console.error("D1 Stripe aggregates query failed:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch Stripe aggregates", 500);
    }
  }
}