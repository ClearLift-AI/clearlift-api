/**
 * D1 Analytics Metrics Endpoints
 *
 * These endpoints read aggregated metrics from D1 ANALYTICS_DB.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1AnalyticsService } from "../../../services/d1-analytics";

/**
 * GET /v1/analytics/metrics/summary - Get analytics summary from D1
 */
export class GetD1MetricsSummary extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get analytics summary from D1",
    description: "Fetches aggregated analytics summary from D1 ANALYTICS_DB (dev environment only)",
    operationId: "get-d1-metrics-summary",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        days: z.string().optional().describe("Number of days to include (default: 7, max: 90)")
      })
    },
    responses: {
      "200": {
        description: "Analytics summary",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                totalEvents: z.number(),
                totalSessions: z.number(),
                totalUsers: z.number(),
                totalConversions: z.number(),
                totalRevenue: z.number(),
                conversionRate: z.number(),
                topChannels: z.array(z.object({
                  channel: z.string(),
                  sessions: z.number(),
                  conversions: z.number()
                })),
                topCampaigns: z.array(z.object({
                  campaign: z.string(),
                  sessions: z.number(),
                  revenue: z.number()
                }))
              })
            })
          }
        }
      },
      "400": { description: "ANALYTICS_DB not configured" },
      "404": { description: "Organization not found" }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const days = parseInt(c.req.query("days") || "7");
    const cappedDays = Math.min(days, 90);

    // Check if ANALYTICS_DB is available
    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured - this endpoint is only available in dev environment", 400);
    }

    // Get org_tag
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag", 404);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const summary = await analyticsService.getAnalyticsSummary(orgTagMapping.short_tag, cappedDays);

    return success(c, summary);
  }
}

/**
 * GET /v1/analytics/metrics/daily - Get daily metrics from D1
 */
export class GetD1DailyMetrics extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get daily metrics from D1",
    description: "Fetches daily aggregated metrics from D1 ANALYTICS_DB",
    operationId: "get-d1-daily-metrics",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Daily metrics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                date: z.string(),
                totalEvents: z.number(),
                pageViews: z.number(),
                clicks: z.number(),
                sessions: z.number(),
                users: z.number(),
                conversions: z.number(),
                revenue: z.number(),
                conversionRate: z.number(),
                byChannel: z.record(z.number()).optional(),
                byDevice: z.record(z.number()).optional(),
                byGeo: z.record(z.number()).optional()
              }))
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const startDate = c.req.query("start_date")!;
    const endDate = c.req.query("end_date")!;

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag", 404);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const metrics = await analyticsService.getDailyMetrics(orgTagMapping.short_tag, startDate, endDate);

    // Transform to API format
    const data = metrics.map(m => ({
      date: m.date,
      totalEvents: m.total_events,
      pageViews: m.page_views,
      clicks: m.clicks,
      sessions: m.sessions,
      users: m.users,
      conversions: m.conversions,
      revenue: m.revenue_cents / 100,
      conversionRate: m.conversion_rate,
      byChannel: m.by_channel ? JSON.parse(m.by_channel) : undefined,
      byDevice: m.by_device ? JSON.parse(m.by_device) : undefined,
      byGeo: m.by_geo ? JSON.parse(m.by_geo) : undefined
    }));

    return success(c, data);
  }
}

/**
 * GET /v1/analytics/metrics/hourly - Get hourly metrics from D1
 */
export class GetD1HourlyMetrics extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get hourly metrics from D1",
    description: "Fetches hourly aggregated metrics from D1 ANALYTICS_DB",
    operationId: "get-d1-hourly-metrics",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().describe("Start datetime (ISO 8601)"),
        end_date: z.string().describe("End datetime (ISO 8601)")
      })
    },
    responses: {
      "200": {
        description: "Hourly metrics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                hour: z.string(),
                totalEvents: z.number(),
                pageViews: z.number(),
                clicks: z.number(),
                sessions: z.number(),
                users: z.number(),
                conversions: z.number(),
                revenue: z.number(),
                byChannel: z.record(z.number()).optional(),
                byDevice: z.record(z.number()).optional()
              }))
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const startDate = c.req.query("start_date")!;
    const endDate = c.req.query("end_date")!;

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag", 404);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const metrics = await analyticsService.getHourlyMetrics(orgTagMapping.short_tag, startDate, endDate);

    const data = metrics.map(m => ({
      hour: m.hour,
      totalEvents: m.total_events,
      pageViews: m.page_views,
      clicks: m.clicks,
      sessions: m.sessions,
      users: m.users,
      conversions: m.conversions,
      revenue: m.revenue_cents / 100,
      byChannel: m.by_channel ? JSON.parse(m.by_channel) : undefined,
      byDevice: m.by_device ? JSON.parse(m.by_device) : undefined
    }));

    return success(c, data);
  }
}

/**
 * GET /v1/analytics/metrics/utm - Get UTM campaign performance from D1
 */
export class GetD1UTMPerformance extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get UTM campaign performance from D1",
    description: "Fetches UTM campaign performance from D1 ANALYTICS_DB",
    operationId: "get-d1-utm-performance",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "UTM performance",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                date: z.string(),
                utmSource: z.string().nullable(),
                utmMedium: z.string().nullable(),
                utmCampaign: z.string().nullable(),
                sessions: z.number(),
                users: z.number(),
                pageViews: z.number(),
                conversions: z.number(),
                revenue: z.number(),
                conversionRate: z.number()
              }))
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const startDate = c.req.query("start_date")!;
    const endDate = c.req.query("end_date")!;

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag", 404);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const metrics = await analyticsService.getUTMPerformance(orgTagMapping.short_tag, startDate, endDate);

    const data = metrics.map(m => ({
      date: m.date,
      utmSource: m.utm_source,
      utmMedium: m.utm_medium,
      utmCampaign: m.utm_campaign,
      sessions: m.sessions,
      users: m.users,
      pageViews: m.page_views,
      conversions: m.conversions,
      revenue: m.revenue_cents / 100,
      conversionRate: m.conversion_rate
    }));

    return success(c, data);
  }
}

/**
 * GET /v1/analytics/metrics/attribution - Get attribution results from D1
 */
export class GetD1Attribution extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get attribution results from D1",
    description: "Fetches multi-touch attribution results from D1 ANALYTICS_DB",
    operationId: "get-d1-attribution",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        model: z.string().optional().describe("Attribution model: markov, shapley, first_touch, last_touch, linear, time_decay, position_based"),
        period_start: z.string().optional().describe("Period start date (ISO 8601)"),
        period_end: z.string().optional().describe("Period end date (ISO 8601)")
      })
    },
    responses: {
      "200": {
        description: "Attribution results",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                model: z.string(),
                channel: z.string(),
                credit: z.number(),
                conversions: z.number(),
                revenue: z.number(),
                removalEffect: z.number().nullable(),
                shapleyValue: z.number().nullable(),
                periodStart: z.string(),
                periodEnd: z.string()
              }))
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const model = c.req.query("model");
    const periodStart = c.req.query("period_start");
    const periodEnd = c.req.query("period_end");

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag", 404);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const results = await analyticsService.getAttributionResults(
      orgTagMapping.short_tag,
      model,
      periodStart,
      periodEnd
    );

    const data = results.map(r => ({
      model: r.model,
      channel: r.channel,
      credit: r.credit,
      conversions: r.conversions,
      revenue: r.revenue_cents / 100,
      removalEffect: r.removal_effect,
      shapleyValue: r.shapley_value,
      periodStart: r.period_start,
      periodEnd: r.period_end
    }));

    return success(c, data);
  }
}

/**
 * GET /v1/analytics/metrics/journeys - Get customer journeys from D1
 */
export class GetD1Journeys extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get customer journeys from D1",
    description: "Fetches customer journey paths from D1 ANALYTICS_DB",
    operationId: "get-d1-journeys",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        limit: z.string().optional().describe("Maximum number of journeys (default: 100)"),
        converted_only: z.string().optional().describe("Only return converted journeys (default: false)")
      })
    },
    responses: {
      "200": {
        description: "Customer journeys",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                id: z.string(),
                channelPath: z.array(z.string()),
                pathLength: z.number(),
                converted: z.boolean(),
                conversionValue: z.number(),
                firstTouchTs: z.string(),
                lastTouchTs: z.string()
              }))
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const limit = parseInt(c.req.query("limit") || "100");
    const convertedOnly = c.req.query("converted_only") === "true";

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag", 404);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const journeys = await analyticsService.getJourneys(orgTagMapping.short_tag, limit, convertedOnly);

    const data = journeys.map(j => ({
      id: j.id,
      channelPath: JSON.parse(j.channel_path || '[]'),
      pathLength: j.path_length,
      converted: j.converted === 1,
      conversionValue: j.conversion_value_cents / 100,
      firstTouchTs: j.first_touch_ts,
      lastTouchTs: j.last_touch_ts
    }));

    return success(c, data);
  }
}

/**
 * GET /v1/analytics/metrics/transitions - Get channel transitions for Markov visualization
 */
export class GetD1ChannelTransitions extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get channel transitions from D1",
    description: "Fetches Markov transition matrix from D1 ANALYTICS_DB",
    operationId: "get-d1-channel-transitions",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        period_start: z.string().optional().describe("Period start date (ISO 8601)")
      })
    },
    responses: {
      "200": {
        description: "Channel transitions",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                fromChannel: z.string(),
                toChannel: z.string(),
                probability: z.number(),
                transitionCount: z.number()
              }))
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const periodStart = c.req.query("period_start");

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization does not have an assigned tag", 404);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const transitions = await analyticsService.getChannelTransitions(orgTagMapping.short_tag, periodStart);

    const data = transitions.map(t => ({
      fromChannel: t.from_channel,
      toChannel: t.to_channel,
      probability: t.probability,
      transitionCount: t.transition_count
    }));

    return success(c, data);
  }
}
