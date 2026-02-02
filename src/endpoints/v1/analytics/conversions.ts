import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext, SetupStatus, buildDataQualityResponse } from "../../../types";
import { success, error, getDateRange } from "../../../utils/response";
import {
  ConversionRecordSchema,
  ConversionResponseSchema,
  type ConversionRecord
} from "../../../schemas/analytics";
import { D1AnalyticsService } from "../../../services/d1-analytics";
import { AD_PLATFORM_IDS, ACTIVE_REVENUE_PLATFORM_IDS } from "../../../config/platforms";

/**
 * Check setup status for conversions
 */
async function checkConversionSetupStatus(
  mainDb: D1Database,
  orgId: string
): Promise<SetupStatus> {
  // Check tracking tag
  const tagMapping = await mainDb.prepare(`
    SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1
  `).bind(orgId).first<{ short_tag: string }>();

  // Check connected platforms
  const platformsResult = await mainDb.prepare(`
    SELECT platform FROM platform_connections WHERE organization_id = ? AND is_active = 1
  `).bind(orgId).all<{ platform: string }>();
  const connectedPlatforms = (platformsResult.results || []).map(r => r.platform);

  const adPlatforms = connectedPlatforms.filter(p => AD_PLATFORM_IDS.includes(p as any));
  const revenueConnectors = connectedPlatforms.filter(p => ACTIVE_REVENUE_PLATFORM_IDS.includes(p as any));

  return {
    hasTrackingTag: !!tagMapping?.short_tag,
    hasAdPlatforms: adPlatforms.length > 0,
    hasRevenueConnector: revenueConnectors.length > 0,
    hasClickIds: false, // Checked separately
    hasUtmData: false, // Checked separately
    trackingDomain: undefined,
    connectedPlatforms: adPlatforms,
    connectedConnectors: revenueConnectors
  };
}

/**
 * GET /v1/analytics/conversions - Get conversion data from D1
 * Primary source: stripe_charges table in ANALYTICS_DB
 */
export class GetConversions extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get conversion data",
    description: "Fetches conversion data from D1 with intelligent aggregation",
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

    // Use D1 ANALYTICS_DB
    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    const d1Analytics = new D1AnalyticsService(c.env.ANALYTICS_DB);

    try {
      // Get all Stripe connections for this org
      const connections = await c.env.DB.prepare(`
        SELECT id FROM platform_connections
        WHERE organization_id = ? AND platform = 'stripe' AND is_active = 1
      `).bind(orgId).all<{ id: string }>();

      if (!connections.results || connections.results.length === 0) {
        // No Stripe connections - return empty with setup guidance
        const setupStatus = await checkConversionSetupStatus(c.env.DB, orgId);
        const setupGuidance = buildDataQualityResponse(setupStatus);

        return success(
          c,
          {
            ...this.formatEmptyResponse(groupBy),
            setup_guidance: setupGuidance,
            _message: 'No revenue source connected. Connect Stripe, Shopify, or Jobber to track conversions.'
          },
          { date_range: dateRange }
        );
      }

      // Query stripe_charges from D1 for all connections
      const allConversions: any[] = [];
      for (const conn of connections.results) {
        const charges = await d1Analytics.getStripeCharges(
          orgId,
          conn.id,
          dateRange.start_date,
          dateRange.end_date,
          {
            status: 'succeeded', // Only successful charges count as conversions
            limit: 1000,
          }
        );

        // Transform charges to conversion format
        const conversions = charges.map(charge => ({
          id: charge.id,
          channel: channel || 'stripe',
          date: charge.stripe_created_at.split('T')[0],
          conversion_count: 1,
          revenue: charge.amount_cents / 100,
          conversion_type: 'purchase'
        }));

        allConversions.push(...conversions);
      }

      if (allConversions.length === 0) {
        // Stripe connected but no conversions in date range
        return success(
          c,
          {
            ...this.formatEmptyResponse(groupBy),
            _message: 'Stripe connected but no conversions found in the selected date range.'
          },
          { date_range: dateRange }
        );
      }

      // Sort by date
      allConversions.sort((a, b) => a.date.localeCompare(b.date));

      // Aggregate data based on group_by parameter
      const result = this.aggregateData(allConversions, groupBy);

      return success(c, { ...result, data_source: 'd1_stripe' }, { date_range: dateRange });
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