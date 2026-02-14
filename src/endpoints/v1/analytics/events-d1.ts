/**
 * D1-based Events Analytics Endpoint
 *
 * Returns aggregated event data from D1 tables (sub-millisecond queries).
 * Replaces slow R2 SQL queries (15-25s) with fast D1 queries.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { structuredLog } from '../../../utils/structured-logger';

/**
 * GET /v1/analytics/events/d1
 * Get aggregated event analytics from D1 (fast)
 */
export class GetEventsD1 extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get aggregated event analytics from D1",
    description: "Returns fast aggregated event data from D1 hourly_metrics and utm_performance tables",
    operationId: "get-events-d1",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        days: z.coerce.number().int().min(1).max(90).optional().default(7).describe("Days to look back (default: 7, max: 90)")
      })
    },
    responses: {
      "200": {
        description: "Aggregated event analytics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                summary: z.object({
                  totalEvents: z.number(),
                  pageViews: z.number(),
                  clicks: z.number(),
                  formSubmits: z.number(),
                  customEvents: z.number(),
                  sessions: z.number(),
                  users: z.number(),
                  devices: z.number(),
                  conversions: z.number(),
                  revenue: z.number()
                }),
                timeSeries: z.array(z.object({
                  hour: z.string(),
                  totalEvents: z.number(),
                  pageViews: z.number(),
                  sessions: z.number(),
                  conversions: z.number()
                })),
                byChannel: z.array(z.object({
                  channel: z.string(),
                  events: z.number()
                })),
                byDevice: z.array(z.object({
                  device: z.string(),
                  events: z.number()
                })),
                utmPerformance: z.array(z.object({
                  utmSource: z.string(),
                  utmMedium: z.string().nullable(),
                  utmCampaign: z.string().nullable(),
                  sessions: z.number(),
                  pageViews: z.number(),
                  conversions: z.number(),
                  revenue: z.number()
                }))
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const days = parseInt(c.req.query("days") || "7");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    // Get org_tag from mapping
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const orgTag = orgTagMapping.short_tag;
    const analyticsDb = c.env.ANALYTICS_DB;

    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Run all queries in parallel for speed
      const [summaryResult, timeSeriesResult, utmResult] = await Promise.all([
        // 1. Summary metrics from hourly_metrics
        analyticsDb.prepare(`
          SELECT
            COALESCE(SUM(total_events), 0) as total_events,
            COALESCE(SUM(page_views), 0) as page_views,
            COALESCE(SUM(clicks), 0) as clicks,
            COALESCE(SUM(form_submits), 0) as form_submits,
            COALESCE(SUM(custom_events), 0) as custom_events,
            COALESCE(SUM(sessions), 0) as sessions,
            COALESCE(SUM(users), 0) as users,
            COALESCE(SUM(devices), 0) as devices,
            COALESCE(SUM(conversions), 0) as conversions,
            COALESCE(SUM(revenue_cents), 0) as revenue_cents
          FROM hourly_metrics
          WHERE org_tag = ?
            AND hour >= datetime('now', '-' || ? || ' days')
        `).bind(orgTag, days).first(),

        // 2. Time series from hourly_metrics
        analyticsDb.prepare(`
          SELECT
            hour,
            total_events,
            page_views,
            sessions,
            conversions,
            by_channel,
            by_device
          FROM hourly_metrics
          WHERE org_tag = ?
            AND hour >= datetime('now', '-' || ? || ' days')
          ORDER BY hour ASC
        `).bind(orgTag, days).all(),

        // 3. UTM performance
        analyticsDb.prepare(`
          SELECT
            utm_source,
            utm_medium,
            utm_campaign,
            SUM(sessions) as sessions,
            SUM(page_views) as page_views,
            SUM(conversions) as conversions,
            SUM(revenue_cents) as revenue_cents
          FROM utm_performance
          WHERE org_tag = ?
            AND date >= date('now', '-' || ? || ' days')
          GROUP BY utm_source, utm_medium, utm_campaign
          ORDER BY sessions DESC
          LIMIT 50
        `).bind(orgTag, days).all()
      ]);

      // Aggregate channel and device data from time series
      const channelTotals: Record<string, number> = {};
      const deviceTotals: Record<string, number> = {};

      for (const row of (timeSeriesResult.results || []) as any[]) {
        // Parse by_channel JSON
        if (row.by_channel) {
          try {
            const channels = JSON.parse(row.by_channel);
            for (const [channel, count] of Object.entries(channels)) {
              channelTotals[channel] = (channelTotals[channel] || 0) + (count as number);
            }
          } catch (e) { /* ignore parse errors */ }
        }

        // Parse by_device JSON
        if (row.by_device) {
          try {
            const devices = JSON.parse(row.by_device);
            for (const [device, count] of Object.entries(devices)) {
              deviceTotals[device] = (deviceTotals[device] || 0) + (count as number);
            }
          } catch (e) { /* ignore parse errors */ }
        }
      }

      // Format response
      const summary = summaryResult as any || {};

      return success(c, {
        summary: {
          totalEvents: summary.total_events || 0,
          pageViews: summary.page_views || 0,
          clicks: summary.clicks || 0,
          formSubmits: summary.form_submits || 0,
          customEvents: summary.custom_events || 0,
          sessions: summary.sessions || 0,
          users: summary.users || 0,
          devices: summary.devices || 0,
          conversions: summary.conversions || 0,
          revenue: (summary.revenue_cents || 0) / 100
        },
        timeSeries: ((timeSeriesResult.results || []) as any[]).map(row => ({
          hour: row.hour,
          totalEvents: row.total_events || 0,
          pageViews: row.page_views || 0,
          sessions: row.sessions || 0,
          conversions: row.conversions || 0
        })),
        byChannel: Object.entries(channelTotals)
          .map(([channel, events]) => ({ channel, events }))
          .sort((a, b) => b.events - a.events),
        byDevice: Object.entries(deviceTotals)
          .map(([device, events]) => ({ device, events }))
          .sort((a, b) => b.events - a.events),
        utmPerformance: ((utmResult.results || []) as any[]).map(row => ({
          utmSource: row.utm_source || '(direct)',
          utmMedium: row.utm_medium,
          utmCampaign: row.utm_campaign,
          sessions: row.sessions || 0,
          pageViews: row.page_views || 0,
          conversions: row.conversions || 0,
          revenue: (row.revenue_cents || 0) / 100
        }))
      });
    } catch (err) {
      structuredLog('ERROR', 'Events D1 query failed', { endpoint: 'analytics/events-d1', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}
