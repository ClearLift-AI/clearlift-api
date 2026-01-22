import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error, getDateRange } from "../../../utils/response";

/**
 * GET /v1/analytics/tracking-links - Get tracking link performance metrics
 *
 * Returns clicks, conversions, revenue, and conversion rate for each tracking link.
 * Links metadata comes from D1. Conversion/click data requires D1 tables to be populated.
 */
export class GetTrackingLinkPerformance extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get tracking link performance metrics",
    description: "Returns clicks, conversions, revenue, and conversion rates for email tracking links",
    operationId: "get-tracking-link-performance",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      }),
    },
    responses: {
      "200": {
        description: "Tracking link performance data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                links: z.array(
                  z.object({
                    link_id: z.string(),
                    link_name: z.string().nullable(),
                    destination_url: z.string(),
                    utm_campaign: z.string().nullable(),
                    clicks: z.number(),
                    conversions: z.number(),
                    revenue_cents: z.number(),
                    conversion_rate: z.number(),
                    created_at: z.string(),
                  })
                ),
                totals: z.object({
                  total_clicks: z.number(),
                  total_conversions: z.number(),
                  total_revenue_cents: z.number(),
                  avg_conversion_rate: z.number(),
                }),
              }),
              meta: z.object({
                timestamp: z.string(),
                date_range: z.object({
                  start_date: z.string(),
                  end_date: z.string(),
                }),
              }),
            }),
          },
        },
      },
      "401": { description: "Unauthorized" },
      "403": { description: "No organization selected" },
      "500": { description: "Query failed" },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const dateRange = getDateRange(c);

    // Get org_tag from org_id
    const orgTagResult = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings
      WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagResult?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization tag not found", 404);
    }

    const orgTag = orgTagResult.short_tag;

    try {
      // Fetch link metadata from D1
      const linksResult = await c.env.DB.prepare(`
        SELECT id, name, destination_url, utm_campaign, created_at
        FROM tracking_links
        WHERE org_tag = ? AND is_active = 1
        ORDER BY created_at DESC
      `).bind(orgTag).all<{
        id: string;
        name: string | null;
        destination_url: string;
        utm_campaign: string | null;
        created_at: string;
      }>();

      const links = linksResult.results || [];

      if (links.length === 0) {
        return success(
          c,
          {
            links: [],
            totals: {
              total_clicks: 0,
              total_conversions: 0,
              total_revenue_cents: 0,
              avg_conversion_rate: 0,
            },
          },
          { date_range: dateRange }
        );
      }

      // Query clicks from tracked_clicks in ANALYTICS_DB
      const clicksResult = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          utm_campaign,
          COUNT(*) as clicks,
          SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) as conversions
        FROM tracked_clicks
        WHERE organization_id = ?
          AND click_timestamp >= ?
          AND click_timestamp <= ?
          AND utm_campaign IS NOT NULL
        GROUP BY utm_campaign
      `).bind(orgId, dateRange.start_date, dateRange.end_date + 'T23:59:59Z').all<{
        utm_campaign: string;
        clicks: number;
        conversions: number;
      }>();

      // Query conversion revenue from conversions table
      const revenueResult = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          utm_campaign,
          SUM(value_cents) as revenue_cents
        FROM conversions
        WHERE organization_id = ?
          AND conversion_timestamp >= ?
          AND conversion_timestamp <= ?
          AND utm_campaign IS NOT NULL
        GROUP BY utm_campaign
      `).bind(orgId, dateRange.start_date, dateRange.end_date + 'T23:59:59Z').all<{
        utm_campaign: string;
        revenue_cents: number;
      }>();

      // Build lookup maps
      const clicksMap = new Map((clicksResult.results || []).map(r => [r.utm_campaign, r]));
      const revenueMap = new Map((revenueResult.results || []).map(r => [r.utm_campaign, r.revenue_cents]));

      // Merge link metadata with metrics
      const linksWithMetrics = links.map((link) => {
        const clickData = link.utm_campaign ? clicksMap.get(link.utm_campaign) : null;
        const revenue = link.utm_campaign ? (revenueMap.get(link.utm_campaign) || 0) : 0;
        const clicks = clickData?.clicks || 0;
        const conversions = clickData?.conversions || 0;

        return {
          link_id: link.id,
          link_name: link.name,
          destination_url: link.destination_url,
          utm_campaign: link.utm_campaign,
          clicks,
          conversions,
          revenue_cents: revenue,
          conversion_rate: clicks > 0 ? (conversions / clicks) * 100 : 0,
          created_at: link.created_at,
        };
      });

      // Calculate totals
      const totals = linksWithMetrics.reduce((acc, link) => ({
        total_clicks: acc.total_clicks + link.clicks,
        total_conversions: acc.total_conversions + link.conversions,
        total_revenue_cents: acc.total_revenue_cents + link.revenue_cents,
        avg_conversion_rate: 0, // Calculate after
      }), {
        total_clicks: 0,
        total_conversions: 0,
        total_revenue_cents: 0,
        avg_conversion_rate: 0,
      });

      totals.avg_conversion_rate = totals.total_clicks > 0
        ? (totals.total_conversions / totals.total_clicks) * 100
        : 0;

      console.log(`[TrackingLinks] Returning ${links.length} links with metrics from ANALYTICS_DB`);

      return success(
        c,
        {
          links: linksWithMetrics,
          totals,
        },
        { date_range: dateRange }
      );
    } catch (err) {
      console.error("Failed to fetch tracking link performance:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch tracking link performance", 500);
    }
  }
}
