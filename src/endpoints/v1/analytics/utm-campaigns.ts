/**
 * UTM Campaign Performance Endpoint
 *
 * Fetches aggregated UTM campaign performance data from D1 utm_performance table.
 * Provides sessions, users, page views, conversions, and bounce rate by UTM parameters.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { structuredLog } from '../../../utils/structured-logger';

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
 * Fetches UTM campaign performance data from D1 utm_performance table.
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

    // Return empty data when required date params are missing
    if (!dateFrom || !dateTo) {
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

    // Get org_tag for querying analytics
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
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

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Query utm_performance table from D1
      let sql = `
        SELECT
          utm_source,
          utm_medium,
          utm_campaign,
          utm_term,
          utm_content,
          SUM(sessions) as sessions,
          SUM(users) as users,
          SUM(page_views) as page_views,
          SUM(conversions) as conversions,
          SUM(revenue_cents) as conversion_value_cents,
          AVG(conversion_rate) as conversion_rate,
          AVG(bounce_rate) as bounce_rate,
          AVG(avg_session_duration_seconds) as avg_session_duration_seconds
        FROM utm_performance
        WHERE org_tag = ?
        AND date >= ? AND date <= ?
      `;
      const params: any[] = [tagMapping.short_tag, dateFrom, dateTo];

      if (utmSourceFilter) {
        sql += ' AND utm_source = ?';
        params.push(utmSourceFilter);
      }

      sql += ` GROUP BY utm_source, utm_medium, utm_campaign, utm_term, utm_content
               ORDER BY sessions DESC
               LIMIT ${limit}`;

      const result = await c.env.ANALYTICS_DB.prepare(sql).bind(...params).all<any>();
      const records = result.results || [];

      // Get unique sources
      const sourcesResult = await c.env.ANALYTICS_DB.prepare(`
        SELECT DISTINCT utm_source
        FROM utm_performance
        WHERE org_tag = ? AND date >= ? AND date <= ? AND utm_source IS NOT NULL
        ORDER BY utm_source
      `).bind(tagMapping.short_tag, dateFrom, dateTo).all<{ utm_source: string }>();
      const uniqueSources = (sourcesResult.results || []).map(r => r.utm_source);

      // Transform to response format
      const campaigns = records.map(row => ({
        utm_source: row.utm_source || "direct",
        utm_medium: row.utm_medium || null,
        utm_campaign: row.utm_campaign || null,
        utm_term: row.utm_term || null,
        utm_content: row.utm_content || null,
        sessions: row.sessions || 0,
        users: row.users || 0,
        page_views: row.page_views || 0,
        conversions: row.conversions || 0,
        conversion_value_cents: row.conversion_value_cents || 0,
        conversion_rate: row.sessions > 0 ? Math.round((row.conversions / row.sessions) * 10000) / 100 : 0,
        bounce_rate: row.bounce_rate || 0,
        avg_session_duration_seconds: row.avg_session_duration_seconds || null,
      }));

      // Calculate summary
      const totalSessions = campaigns.reduce((sum, c) => sum + c.sessions, 0);
      const totalUsers = campaigns.reduce((sum, c) => sum + c.users, 0);
      const totalPageViews = campaigns.reduce((sum, c) => sum + c.page_views, 0);
      const totalConversions = campaigns.reduce((sum, c) => sum + c.conversions, 0);
      const totalRevenueCents = campaigns.reduce((sum, c) => sum + c.conversion_value_cents, 0);
      const avgConversionRate = totalSessions > 0 ? Math.round((totalConversions / totalSessions) * 10000) / 100 : 0;
      const avgBounceRate = campaigns.length > 0 && totalSessions > 0
        ? Math.round(campaigns.reduce((sum, c) => sum + (c.bounce_rate || 0) * c.sessions, 0) / totalSessions * 100) / 100
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
        sources: uniqueSources,
      });
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // D1 throws "no such table" if utm_performance hasn't been populated yet — return empty data
      if (errMsg.includes('no such table') || errMsg.includes('no such column')) {
        structuredLog('WARN', 'UTM table not yet populated', { endpoint: 'analytics/utm-campaigns', error: errMsg });
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
      structuredLog('ERROR', 'UTM campaigns query failed', { endpoint: 'analytics/utm-campaigns', error: errMsg });
      return error(c, "INTERNAL_ERROR", "Failed to fetch UTM campaign data", 500);
    }
  }
}

/**
 * GET /v1/analytics/utm-campaigns/time-series
 *
 * Fetches UTM traffic data as a time series from D1.
 */
export class GetUtmTimeSeries extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get UTM traffic time series",
    description: `
Fetches daily UTM traffic metrics as a time series:
- Sessions, users, conversions by date
- Optionally grouped by utm_source for source breakdown
- Shows "reality" - actual traffic data regardless of ad platform connectivity
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        group_by: z.enum(["date", "source"]).optional().default("date").describe("Group by date only or by date+source"),
      }),
    },
    responses: {
      "200": {
        description: "UTM traffic time series data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                time_series: z.array(z.object({
                  date: z.string(),
                  sessions: z.number(),
                  users: z.number(),
                  conversions: z.number(),
                  conversion_value_cents: z.number(),
                  conversion_rate: z.number(),
                  by_source: z.record(z.object({
                    sessions: z.number(),
                    users: z.number(),
                    conversions: z.number(),
                    conversion_value_cents: z.number(),
                  })).optional(),
                })),
                summary: z.object({
                  total_sessions: z.number(),
                  total_users: z.number(),
                  total_conversions: z.number(),
                  total_revenue_cents: z.number(),
                  avg_conversion_rate: z.number(),
                  sources: z.array(z.string()),
                }),
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
    const groupBy = query.group_by || "date";

    // Return empty data when required date params are missing
    if (!dateFrom || !dateTo) {
      return success(c, {
        time_series: [],
        summary: {
          total_sessions: 0,
          total_users: 0,
          total_conversions: 0,
          total_revenue_cents: 0,
          avg_conversion_rate: 0,
          sources: [],
        },
      });
    }

    // Get org_tag for querying analytics
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      return success(c, {
        time_series: [],
        summary: {
          total_sessions: 0,
          total_users: 0,
          total_conversions: 0,
          total_revenue_cents: 0,
          avg_conversion_rate: 0,
          sources: [],
        },
      });
    }

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Query utm_performance table from D1
      const result = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          date,
          utm_source,
          SUM(sessions) as sessions,
          SUM(users) as users,
          SUM(conversions) as conversions,
          SUM(revenue_cents) as conversion_value_cents
        FROM utm_performance
        WHERE org_tag = ?
        AND date >= ? AND date <= ?
        GROUP BY date, utm_source
        ORDER BY date ASC
      `).bind(tagMapping.short_tag, dateFrom, dateTo).all<any>();

      const records = result.results || [];

      // Aggregate by date (and optionally by source within each date)
      const dateMap = new Map<string, {
        sessions: number;
        users: number;
        conversions: number;
        conversion_value_cents: number;
        by_source: Map<string, { sessions: number; users: number; conversions: number; conversion_value_cents: number }>;
      }>();
      const allSources = new Set<string>();

      for (const record of records) {
        const date = record.date;
        const source = record.utm_source || "direct";
        allSources.add(source);

        if (!dateMap.has(date)) {
          dateMap.set(date, {
            sessions: 0,
            users: 0,
            conversions: 0,
            conversion_value_cents: 0,
            by_source: new Map(),
          });
        }

        const dayData = dateMap.get(date)!;
        dayData.sessions += record.sessions || 0;
        dayData.users += record.users || 0;
        dayData.conversions += record.conversions || 0;
        dayData.conversion_value_cents += record.conversion_value_cents || 0;

        if (groupBy === "source") {
          if (!dayData.by_source.has(source)) {
            dayData.by_source.set(source, { sessions: 0, users: 0, conversions: 0, conversion_value_cents: 0 });
          }
          const sourceData = dayData.by_source.get(source)!;
          sourceData.sessions += record.sessions || 0;
          sourceData.users += record.users || 0;
          sourceData.conversions += record.conversions || 0;
          sourceData.conversion_value_cents += record.conversion_value_cents || 0;
        }
      }

      // Build time series array
      const timeSeries = Array.from(dateMap.entries()).map(([date, data]) => ({
        date,
        sessions: data.sessions,
        users: data.users,
        conversions: data.conversions,
        conversion_value_cents: data.conversion_value_cents,
        conversion_rate: data.sessions > 0 ? Math.round((data.conversions / data.sessions) * 10000) / 100 : 0,
        ...(groupBy === "source" ? {
          by_source: Object.fromEntries(data.by_source)
        } : {})
      }));

      // Calculate summary
      const totalSessions = timeSeries.reduce((sum, d) => sum + d.sessions, 0);
      const totalUsers = timeSeries.reduce((sum, d) => sum + d.users, 0);
      const totalConversions = timeSeries.reduce((sum, d) => sum + d.conversions, 0);
      const totalRevenueCents = timeSeries.reduce((sum, d) => sum + d.conversion_value_cents, 0);
      const avgConversionRate = totalSessions > 0 ? Math.round((totalConversions / totalSessions) * 10000) / 100 : 0;

      return success(c, {
        time_series: timeSeries,
        summary: {
          total_sessions: totalSessions,
          total_users: totalUsers,
          total_conversions: totalConversions,
          total_revenue_cents: totalRevenueCents,
          avg_conversion_rate: avgConversionRate,
          sources: Array.from(allSources).sort(),
        },
      });
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('no such table') || errMsg.includes('no such column')) {
        structuredLog('WARN', 'UTM table not yet populated', { endpoint: 'analytics/utm-campaigns/time-series', error: errMsg });
        return success(c, {
          time_series: [],
          summary: {
            total_sessions: 0,
            total_users: 0,
            total_conversions: 0,
            total_revenue_cents: 0,
            avg_conversion_rate: 0,
            sources: [],
          },
        });
      }
      structuredLog('ERROR', 'UTM time series query failed', { endpoint: 'analytics/utm-campaigns', error: errMsg });
      return error(c, "INTERNAL_ERROR", "Failed to fetch UTM time series data", 500);
    }
  }
}
