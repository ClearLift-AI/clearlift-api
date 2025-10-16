import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error, getDateRange } from "../../../utils/response";
import { createClient } from "@supabase/supabase-js";
import {
  ConversionRecordSchema,
  ConversionResponseSchema,
  type ConversionRecord
} from "../../../schemas/analytics";

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

    // Get Supabase secret key
    let supabaseKey: string;
    if (typeof c.env.SUPABASE_SECRET_KEY === 'string') {
      supabaseKey = c.env.SUPABASE_SECRET_KEY;
    } else if (c.env.SUPABASE_SECRET_KEY && typeof c.env.SUPABASE_SECRET_KEY.get === 'function') {
      supabaseKey = await c.env.SUPABASE_SECRET_KEY.get();
    } else {
      return error(c, "CONFIGURATION_ERROR", "Supabase key not configured", 500);
    }

    const supabase = createClient(c.env.SUPABASE_URL, supabaseKey);

    try {
      // Build base query
      let query = supabase
        .from("conversions")
        .select("*")
        .eq("org_id", orgId)
        .gte("date", dateRange.start_date)
        .lte("date", dateRange.end_date);

      // Filter by channel if specified
      if (channel) {
        query = query.eq("channel", channel);
      }

      // Order by date
      query = query.order("date", { ascending: true });

      const { data: rawData, error: queryError } = await query;

      if (queryError) {
        console.error("Supabase query error:", queryError);
        return error(c, "QUERY_FAILED", queryError.message, 500);
      }

      if (!rawData || rawData.length === 0) {
        // Return empty result structure
        return success(
          c,
          this.formatEmptyResponse(groupBy),
          { date_range: dateRange }
        );
      }

      // Validate and parse raw data through schema
      // This validates required fields while allowing additional fields to pass through
      const validatedData = rawData.map(row => {
        try {
          return ConversionRecordSchema.parse(row);
        } catch (parseError) {
          console.warn("Conversion record validation warning:", parseError);
          // Return row anyway with defaults applied (schema has .default() on fields)
          return ConversionRecordSchema.safeParse(row).data || row;
        }
      }) as ConversionRecord[];

      // Aggregate data based on group_by parameter
      const result = this.aggregateData(validatedData, groupBy);

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
    const totalRevenue = data.reduce((sum, row) => sum + parseFloat(row.revenue || 0), 0);

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
          revenue: parseFloat(row.revenue || 0)
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
   * Group data by channel
   */
  private groupByChannel(data: any[]): any[] {
    const channelMap = new Map<string, { conversions: number; revenue: number }>();

    for (const row of data) {
      const channel = row.channel;
      const existing = channelMap.get(channel) || { conversions: 0, revenue: 0 };

      existing.conversions += row.conversion_count || 0;
      existing.revenue += parseFloat(row.revenue || 0);

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
      existing.revenue += parseFloat(row.revenue || 0);

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