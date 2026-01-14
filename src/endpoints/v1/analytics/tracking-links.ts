import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error, getDateRange } from "../../../utils/response";
import { createClient } from "@supabase/supabase-js";
import { getSecret } from "../../../utils/secrets";

/**
 * GET /v1/analytics/tracking-links - Get tracking link performance metrics
 *
 * Returns clicks, conversions, revenue, and conversion rate for each tracking link.
 * Links data from D1 (metadata) and Supabase (conversions).
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

    // Get Supabase secret key
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase key not configured", 500);
    }

    try {
      // 1. Fetch link metadata from D1
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

      const linkIds = links.map((l) => l.id);

      // 2. Query conversions by email_link_id from Supabase
      const supabase = createClient(c.env.SUPABASE_URL, supabaseKey, {
        db: { schema: "conversions" },
      });

      const { data: conversionsData, error: convError } = await supabase
        .from("conversions")
        .select("email_link_id, revenue_cents")
        .eq("organization_id", orgId)
        .in("email_link_id", linkIds)
        .gte("conversion_timestamp", `${dateRange.start_date}T00:00:00Z`)
        .lte("conversion_timestamp", `${dateRange.end_date}T23:59:59Z`);

      if (convError) {
        console.error("Failed to fetch conversions:", convError);
        // Continue with empty conversions data
      }

      // Aggregate conversions by link_id
      const conversionsByLink = new Map<string, { count: number; revenue: number }>();
      for (const conv of conversionsData || []) {
        if (!conv.email_link_id) continue;
        const existing = conversionsByLink.get(conv.email_link_id) || { count: 0, revenue: 0 };
        existing.count += 1;
        existing.revenue += conv.revenue_cents || 0;
        conversionsByLink.set(conv.email_link_id, existing);
      }

      // 3. Query clicks from events.events_slim table
      const eventsSupabase = createClient(c.env.SUPABASE_URL, supabaseKey, {
        db: { schema: "events" },
      });

      // Query email_click events with link_id in custom_dimensions
      const { data: clicksData, error: clicksError } = await eventsSupabase
        .from("events_slim")
        .select("custom_dimensions")
        .eq("org_tag", orgTag)
        .eq("event_type", "email_click")
        .gte("timestamp", `${dateRange.start_date}T00:00:00Z`)
        .lte("timestamp", `${dateRange.end_date}T23:59:59Z`);

      if (clicksError) {
        console.error("Failed to fetch clicks:", clicksError);
        // Continue with empty clicks data
      }

      // Aggregate clicks by link_id
      const clicksByLink = new Map<string, number>();
      for (const event of clicksData || []) {
        const customDims = event.custom_dimensions as Record<string, unknown> | null;
        const linkId = customDims?.link_id as string | undefined;
        if (linkId) {
          clicksByLink.set(linkId, (clicksByLink.get(linkId) || 0) + 1);
        }
      }

      // 4. Combine link metadata with metrics
      const linksWithMetrics = links.map((link) => {
        const conversions = conversionsByLink.get(link.id) || { count: 0, revenue: 0 };
        const clicks = clicksByLink.get(link.id) || 0;
        const conversionRate = clicks > 0 ? (conversions.count / clicks) * 100 : 0;

        return {
          link_id: link.id,
          link_name: link.name,
          destination_url: link.destination_url,
          utm_campaign: link.utm_campaign,
          clicks,
          conversions: conversions.count,
          revenue_cents: conversions.revenue,
          conversion_rate: Math.round(conversionRate * 100) / 100, // Round to 2 decimal places
          created_at: link.created_at,
        };
      });

      // 5. Calculate totals
      const totals = linksWithMetrics.reduce(
        (acc, link) => {
          acc.total_clicks += link.clicks;
          acc.total_conversions += link.conversions;
          acc.total_revenue_cents += link.revenue_cents;
          return acc;
        },
        { total_clicks: 0, total_conversions: 0, total_revenue_cents: 0, avg_conversion_rate: 0 }
      );

      totals.avg_conversion_rate =
        totals.total_clicks > 0
          ? Math.round((totals.total_conversions / totals.total_clicks) * 100 * 100) / 100
          : 0;

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
