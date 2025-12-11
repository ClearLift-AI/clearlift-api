/**
 * UTM Campaign Performance Endpoint
 *
 * Fetches aggregated UTM campaign performance data from the events.utm_campaign_performance table.
 * Provides sessions, users, page views, conversions, and bounce rate by UTM parameters.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error, getDateRange } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

const UtmCampaignSchema = z.object({
  utm_source: z.string(),
  utm_medium: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  utm_term: z.string().nullable(),
  utm_content: z.string().nullable(),
  sessions: z.number(),
  users: z.number(),
  page_views: z.number(),
  conversions: z.number(),
  conversion_value_cents: z.number(),
  conversion_rate: z.number(),
  bounce_rate: z.number(),
  avg_session_duration_seconds: z.number().nullable(),
});

const UtmCampaignSummarySchema = z.object({
  total_sessions: z.number(),
  total_users: z.number(),
  total_page_views: z.number(),
  total_conversions: z.number(),
  total_revenue_cents: z.number(),
  avg_conversion_rate: z.number(),
  avg_bounce_rate: z.number(),
});

/**
 * GET /v1/analytics/utm-campaigns
 *
 * Fetches UTM campaign performance data from Supabase events.utm_campaign_performance table.
 */
export class GetUtmCampaigns extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get UTM campaign performance",
    description: `
Fetches aggregated UTM campaign performance data including:
- Sessions, users, and page views per UTM combination
- Conversions and revenue
- Bounce rate and session duration
- Filterable by date range and utm_source
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        utm_source: z.string().optional().describe("Filter by specific utm_source"),
        limit: z.string().optional().default("100").describe("Max results to return (default 100)"),
      }),
    },
    responses: {
      "200": {
        description: "UTM campaign performance data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                campaigns: z.array(UtmCampaignSchema),
                summary: UtmCampaignSummarySchema,
                sources: z.array(z.string()).describe("Unique utm_source values for filtering"),
              }),
            }),
          },
        },
      },
      "401": { description: "Unauthorized" },
      "403": { description: "No organization access" },
      "500": { description: "Internal server error" },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const dateFrom = query.date_from;
    const dateTo = query.date_to;
    const utmSourceFilter = query.utm_source;
    const limit = parseInt(query.limit || "100", 10);

    // Get org_tag for querying events schema
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      // No tracking configured - return empty data
      return success(c, {
        campaigns: [],
        summary: {
          total_sessions: 0,
          total_users: 0,
          total_page_views: 0,
          total_conversions: 0,
          total_revenue_cents: 0,
          avg_conversion_rate: 0,
          avg_bounce_rate: 0,
        },
        sources: [],
      });
    }

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey,
      });

      // Build query for utm_campaign_performance table
      const params = new URLSearchParams();
      params.append("org_tag", `eq.${tagMapping.short_tag}`);
      params.append("date", `gte.${dateFrom}`);
      params.append("date", `lte.${dateTo}`);
      params.append("select", "utm_source,utm_medium,utm_campaign,utm_term,utm_content,sessions,users,page_views,conversions,conversion_value_cents,conversion_rate,bounce_rate,avg_session_duration_seconds");
      params.append("order", "sessions.desc");
      params.append("limit", String(limit));

      if (utmSourceFilter) {
        params.append("utm_source", `eq.${utmSourceFilter}`);
      }

      const records = await supabase.queryWithSchema<any[]>(
        `utm_campaign_performance?${params.toString()}`,
        "events",
        { method: "GET" }
      ) || [];

      // Aggregate data by utm_source + utm_medium + utm_campaign
      const aggregatedMap = new Map<string, any>();
      const uniqueSources = new Set<string>();

      for (const record of records) {
        const key = `${record.utm_source || ""}|${record.utm_medium || ""}|${record.utm_campaign || ""}`;

        if (record.utm_source) {
          uniqueSources.add(record.utm_source);
        }

        if (aggregatedMap.has(key)) {
          const existing = aggregatedMap.get(key);
          existing.sessions += record.sessions || 0;
          existing.users += record.users || 0;
          existing.page_views += record.page_views || 0;
          existing.conversions += record.conversions || 0;
          existing.conversion_value_cents += record.conversion_value_cents || 0;
          existing._bounce_rate_sum += (record.bounce_rate || 0) * (record.sessions || 0);
          existing._session_duration_sum += (record.avg_session_duration_seconds || 0) * (record.sessions || 0);
          existing._count++;
        } else {
          aggregatedMap.set(key, {
            utm_source: record.utm_source,
            utm_medium: record.utm_medium || null,
            utm_campaign: record.utm_campaign || null,
            utm_term: record.utm_term || null,
            utm_content: record.utm_content || null,
            sessions: record.sessions || 0,
            users: record.users || 0,
            page_views: record.page_views || 0,
            conversions: record.conversions || 0,
            conversion_value_cents: record.conversion_value_cents || 0,
            _bounce_rate_sum: (record.bounce_rate || 0) * (record.sessions || 0),
            _session_duration_sum: (record.avg_session_duration_seconds || 0) * (record.sessions || 0),
            _count: 1,
          });
        }
      }

      // Calculate final metrics
      const campaigns = Array.from(aggregatedMap.values()).map(row => ({
        utm_source: row.utm_source,
        utm_medium: row.utm_medium,
        utm_campaign: row.utm_campaign,
        utm_term: row.utm_term,
        utm_content: row.utm_content,
        sessions: row.sessions,
        users: row.users,
        page_views: row.page_views,
        conversions: row.conversions,
        conversion_value_cents: row.conversion_value_cents,
        conversion_rate: row.sessions > 0 ? Math.round((row.conversions / row.sessions) * 10000) / 100 : 0,
        bounce_rate: row.sessions > 0 ? Math.round((row._bounce_rate_sum / row.sessions) * 100) / 100 : 0,
        avg_session_duration_seconds: row.sessions > 0 ? Math.round(row._session_duration_sum / row.sessions) : null,
      })).sort((a, b) => b.sessions - a.sessions);

      // Calculate summary
      const totalSessions = campaigns.reduce((sum, c) => sum + c.sessions, 0);
      const totalUsers = campaigns.reduce((sum, c) => sum + c.users, 0);
      const totalPageViews = campaigns.reduce((sum, c) => sum + c.page_views, 0);
      const totalConversions = campaigns.reduce((sum, c) => sum + c.conversions, 0);
      const totalRevenueCents = campaigns.reduce((sum, c) => sum + c.conversion_value_cents, 0);
      const avgConversionRate = totalSessions > 0 ? Math.round((totalConversions / totalSessions) * 10000) / 100 : 0;
      const avgBounceRate = campaigns.length > 0
        ? Math.round(campaigns.reduce((sum, c) => sum + c.bounce_rate * c.sessions, 0) / totalSessions * 100) / 100
        : 0;

      return success(c, {
        campaigns,
        summary: {
          total_sessions: totalSessions,
          total_users: totalUsers,
          total_page_views: totalPageViews,
          total_conversions: totalConversions,
          total_revenue_cents: totalRevenueCents,
          avg_conversion_rate: avgConversionRate,
          avg_bounce_rate: avgBounceRate,
        },
        sources: Array.from(uniqueSources).sort(),
      });
    } catch (err: any) {
      console.error("UTM campaigns error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to fetch UTM campaign data", 500);
    }
  }
}
