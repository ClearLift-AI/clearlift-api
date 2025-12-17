import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error, getDateRange } from "../../../utils/response";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  ConversionRecordSchema,
  ConversionResponseSchema,
  type ConversionRecord
} from "../../../schemas/analytics";
import { getSecret } from "../../../utils/secrets";

/**
 * GET /v1/analytics/conversions - Get conversion data from Supabase
 */
export class GetConversions extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get conversion data",
    description: "Fetches conversion data from Supabase with intelligent aggregation",
    operationId: "get-conversions",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
        channel: z.string().optional().describe("Filter by channel (shopify, stripe, etc.)"),
        group_by: z.enum(["channel", "date", "both", "none"]).optional().describe("Aggregation level (default: none)")
      })
    },
    responses: {
      "200": {
        description: "Conversion data with validated core fields and flexible schema",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: ConversionResponseSchema,
              meta: z.object({
                timestamp: z.string(),
                date_range: z.object({
                  start_date: z.string(),
                  end_date: z.string()
                })
              })
            })
          }
        }
      },
      "401": { description: "Unauthorized" },
      "403": { description: "No organization selected" },
      "500": { description: "Query failed" }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const dateRange = getDateRange(c);
    const channel = c.req.query("channel");
    const groupBy = c.req.query("group_by") || "none";

    // Get Supabase secret key from Secrets Store
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase key not configured", 500);
    }

    // Use conversions schema for conversions table
    const supabase = createClient(c.env.SUPABASE_URL, supabaseKey, {
      db: { schema: 'conversions' }
    });

    try {
      // Build base query using correct column names from conversions.conversions
      let query = supabase
        .from("conversions")
        .select("id, organization_id, source_platform, revenue_cents, conversion_timestamp, conversion_type")
        .eq("organization_id", orgId)
        .gte("conversion_timestamp", `${dateRange.start_date}T00:00:00Z`)
        .lte("conversion_timestamp", `${dateRange.end_date}T23:59:59Z`);

      // Filter by source_platform (was "channel")
      if (channel) {
        query = query.eq("source_platform", channel);
      }

      // Order by conversion_timestamp
      query = query.order("conversion_timestamp", { ascending: true });

      const { data: rawData, error: queryError } = await query;

      if (queryError) {
        console.error("Supabase query error:", queryError);
        return error(c, "QUERY_FAILED", queryError.message, 500);
      }

      if (!rawData || rawData.length === 0) {
        // No data in conversions.conversions - check conversion_source setting
        const conversionSourceSetting = await c.env.DB.prepare(`
          SELECT conversion_source FROM ai_optimization_settings WHERE org_id = ?
        `).bind(orgId).first<{ conversion_source: string | null }>();

        const conversionSource = conversionSourceSetting?.conversion_source || 'tag';

        // If conversion_source is 'connectors', fallback to Stripe data
        if (conversionSource === 'connectors') {
          const stripeData = await this.fetchStripeConversionsFallback(
            c.env.SUPABASE_URL,
            supabaseKey,
            orgId,
            dateRange,
            c.env.DB
          );

          if (stripeData && stripeData.length > 0) {
            const result = this.aggregateData(stripeData, groupBy);
            return success(c, { ...result, data_source: 'stripe_fallback' }, { date_range: dateRange });
          }
        }

        // Return empty result structure
        return success(
          c,
          this.formatEmptyResponse(groupBy),
          { date_range: dateRange }
        );
      }

      // Transform raw data from conversions.conversions schema to expected format
      // - source_platform -> channel
      // - revenue_cents -> revenue (convert to dollars)
      // - conversion_timestamp -> date (extract date part)
      // - Each row = 1 conversion (no conversion_count column)
      const transformedData = rawData.map(row => ({
        id: row.id,
        channel: row.source_platform,
        date: row.conversion_timestamp?.split('T')[0] || row.conversion_timestamp,
        conversion_count: 1, // Each row is one conversion
        revenue: (row.revenue_cents || 0) / 100, // Convert cents to dollars
        conversion_type: row.conversion_type
      }));

      // Aggregate data based on group_by parameter
      const result = this.aggregateData(transformedData, groupBy);

      return success(c, result, { date_range: dateRange });
    } catch (err) {
      console.error("Failed to fetch conversions:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch conversion data", 500);
    }
  }

  /**
   * Aggregate raw conversion data based on grouping strategy
   */
  private aggregateData(data: any[], groupBy: string): any {
    const totalConversions = data.reduce((sum, row) => sum + (row.conversion_count || 0), 0);
    const totalRevenue = data.reduce((sum, row) => sum + (row.revenue || 0), 0);

    switch (groupBy) {
      case "channel": {
        // Group by channel
        const byChannel = this.groupByChannel(data);
        return {
          by_channel: byChannel,
          total_conversions: totalConversions,
          total_revenue: totalRevenue
        };
      }

      case "date": {
        // Group by date
        const byDate = this.groupByDate(data);
        return {
          by_date: byDate,
          total_conversions: totalConversions,
          total_revenue: totalRevenue
        };
      }

      case "both": {
        // Return full breakdown (already grouped by date and channel)
        const breakdown = data.map(row => ({
          date: row.date,
          channel: row.channel,
          conversions: row.conversion_count || 0,
          revenue: row.revenue || 0
        }));
        return {
          breakdown,
          total_conversions: totalConversions,
          total_revenue: totalRevenue
        };
      }

      case "none":
      default: {
        // Total aggregation only
        const uniqueChannels = new Set(data.map(row => row.channel));
        return {
          total_conversions: totalConversions,
          total_revenue: totalRevenue,
          channel_count: uniqueChannels.size
        };
      }
    }
  }

  /**
   * Group data by channel (source_platform)
   */
  private groupByChannel(data: any[]): any[] {
    const channelMap = new Map<string, { conversions: number; revenue: number }>();

    for (const row of data) {
      const channel = row.channel;
      const existing = channelMap.get(channel) || { conversions: 0, revenue: 0 };

      existing.conversions += row.conversion_count || 0;
      existing.revenue += row.revenue || 0;

      channelMap.set(channel, existing);
    }

    return Array.from(channelMap.entries()).map(([channel, stats]) => ({
      channel,
      conversions: stats.conversions,
      revenue: stats.revenue
    }));
  }

  /**
   * Group data by date
   */
  private groupByDate(data: any[]): any[] {
    const dateMap = new Map<string, { conversions: number; revenue: number }>();

    for (const row of data) {
      const date = row.date;
      const existing = dateMap.get(date) || { conversions: 0, revenue: 0 };

      existing.conversions += row.conversion_count || 0;
      existing.revenue += row.revenue || 0;

      dateMap.set(date, existing);
    }

    return Array.from(dateMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0])) // Sort by date
      .map(([date, stats]) => ({
        date,
        conversions: stats.conversions,
        revenue: stats.revenue
      }));
  }

  /**
   * Format empty response based on grouping
   */
  private formatEmptyResponse(groupBy: string): any {
    switch (groupBy) {
      case "channel":
        return { by_channel: [], total_conversions: 0, total_revenue: 0 };
      case "date":
        return { by_date: [], total_conversions: 0, total_revenue: 0 };
      case "both":
        return { breakdown: [], total_conversions: 0, total_revenue: 0 };
      default:
        return { total_conversions: 0, total_revenue: 0, channel_count: 0 };
    }
  }
}