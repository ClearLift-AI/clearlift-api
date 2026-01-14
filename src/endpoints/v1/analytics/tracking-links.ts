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

      // TODO: Query clicks and conversions from D1 when tables are available
      // For now, return links with zero metrics as the events/conversions tables
      // need to be created and populated in D1 ANALYTICS_DB.

      console.log(`[TrackingLinks] Returning ${links.length} links with empty metrics (D1 tables not yet populated)`);

      // Return link metadata with zero metrics
      const linksWithMetrics = links.map((link) => ({
        link_id: link.id,
        link_name: link.name,
        destination_url: link.destination_url,
        utm_campaign: link.utm_campaign,
        clicks: 0,
        conversions: 0,
        revenue_cents: 0,
        conversion_rate: 0,
        created_at: link.created_at,
      }));

      return success(
        c,
        {
          links: linksWithMetrics,
          totals: {
            total_clicks: 0,
            total_conversions: 0,
            total_revenue_cents: 0,
            avg_conversion_rate: 0,
          },
        },
        { date_range: dateRange }
      );
    } catch (err) {
      console.error("Failed to fetch tracking link performance:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch tracking link performance", 500);
    }
  }
}
