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
import { R2SQLAdapter } from "../../../adapters/platforms/r2sql";
import { getSecret } from "../../../utils/secrets";
import { structuredLog } from "../../../utils/structured-logger";

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


    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const summary = await analyticsService.getAnalyticsSummary(orgId, cappedDays);

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
    const startDate = c.req.query("start_date");
    const endDate = c.req.query("end_date");

    if (!startDate || !endDate) {
      return error(c, "INVALID_PARAMS", "start_date and end_date are required", 400);
    }

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const metrics = await analyticsService.getDailyMetrics(orgId, startDate, endDate);

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
      conversionRate: Math.min(m.conversion_rate, 1.0),
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

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const metrics = await analyticsService.getHourlyMetrics(orgId, startDate, endDate);

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

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const metrics = await analyticsService.getUTMPerformance(orgId, startDate, endDate);

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
      conversionRate: Math.min(m.conversion_rate, 1.0)
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

    // Map API model names to DB model names (markov_chain → markov, shapley_value → shapley)
    const dbModel = model === 'markov_chain' ? 'markov' : model === 'shapley_value' ? 'shapley' : model;

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const results = await analyticsService.getAttributionResults(
      orgId,
      dbModel,
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

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const journeys = await analyticsService.getJourneys(orgId, limit, convertedOnly);

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
    description: "Fetches Markov transition matrix from D1 ANALYTICS_DB with optional filtering",
    operationId: "get-d1-channel-transitions",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        period_start: z.string().optional().describe("Filter by period start date (ISO 8601)"),
        period_end: z.string().optional().describe("Filter by period end date (ISO 8601)"),
        from_channel: z.string().optional().describe("Filter by source channel"),
        to_channel: z.string().optional().describe("Filter by destination channel"),
        min_count: z.string().optional().describe("Minimum transition count to include")
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
    const periodEnd = c.req.query("period_end");
    const fromChannel = c.req.query("from_channel");
    const toChannel = c.req.query("to_channel");
    const minCountStr = c.req.query("min_count");
    const minCount = minCountStr ? parseInt(minCountStr, 10) : undefined;

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const transitions = await analyticsService.getChannelTransitions(orgId, {
      periodStart,
      periodEnd,
      fromChannel,
      toChannel,
      minCount
    });

    const data = transitions.map(t => ({
      fromChannel: t.from_channel,
      toChannel: t.to_channel,
      probability: t.probability,
      transitionCount: t.transition_count
    }));

    return success(c, data);
  }
}

/**
 * GET /v1/analytics/metrics/page-flow - Get page-to-page flow transitions for Sankey visualization
 */
export class GetD1PageFlow extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get page flow transitions from D1",
    description: "Fetches page-to-page navigation transitions from funnel_transitions for Sankey visualization",
    operationId: "get-d1-page-flow",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        period_start: z.string().optional().describe("Filter by period start date (ISO 8601)"),
        period_end: z.string().optional().describe("Filter by period end date (ISO 8601)"),
        limit: z.string().optional().describe("Max transitions to return (default 50)")
      })
    },
    responses: {
      "200": {
        description: "Page flow transitions",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                transitions: z.array(z.object({
                  from_id: z.string(),
                  from_name: z.string().nullable(),
                  from_type: z.string().optional(),
                  to_id: z.string(),
                  to_name: z.string().nullable(),
                  visitors_at_from: z.number(),
                  visitors_transitioned: z.number(),
                  transition_rate: z.number(),
                  conversions: z.number(),
                  revenue_cents: z.number()
                })),
                source: z.enum(['d1', 'r2sql']).describe("Data source: d1 for hot storage, r2sql for historical reconstruction")
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const periodStart = c.req.query("period_start");
    const periodEnd = c.req.query("period_end");
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    if (!c.env.ANALYTICS_DB) {
      return error(c, "NOT_CONFIGURED", "ANALYTICS_DB not configured", 400);
    }

    // Resolve org_tag for R2 SQL fallback (R2 indexes by org_tag, not organization_id)
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();
    const orgTag = orgTagMapping?.short_tag || '';

    // Check if request extends beyond D1's 30-day hot window (use 32 days to avoid
    // edge cases where default "last 30 days" range lands 31 days ago)
    const hotWindowCutoff = new Date(Date.now() - 32 * 86_400_000).toISOString().slice(0, 10);
    const needsR2Fallback = periodStart && periodStart < hotWindowCutoff;

    if (needsR2Fallback) {
      // R2 SQL fallback: reconstruct page flow from raw events
      try {
        const r2ApiToken = await getSecret(c.env.R2_SQL_TOKEN);
        if (!r2ApiToken) {
          // No R2 token — fall through to D1 with whatever data is available
          structuredLog('WARN', 'R2 SQL token not configured, falling back to D1', { endpoint: 'page-flow', org_tag: orgTag });
        } else {
          const r2sql = new R2SQLAdapter(
            c.env.CLOUDFLARE_ACCOUNT_ID || '',
            c.env.R2_BUCKET_NAME || 'clearlift-events-lake',
            r2ApiToken,
            c.env.R2_SQL_TABLE || 'clearlift.event_data_v5'
          );
          const transitions = await this.reconstructPageFlowFromR2(r2sql, orgTag, periodStart, periodEnd || new Date().toISOString().slice(0, 10), limit || 50);
          // Only return R2 results if we got data — otherwise fall through to D1
          if (transitions.length > 0) {
            return success(c, { transitions, source: 'r2sql' });
          }
          structuredLog('INFO', 'R2 SQL returned empty results, falling back to D1', { endpoint: 'page-flow', org_tag: orgTag });
        }
      } catch (err) {
        structuredLog('WARN', 'R2 SQL page flow reconstruction failed, falling back to D1', {
          endpoint: 'page-flow', org_tag: orgTag, error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // D1 hot path: aggregated daily rows
    const analyticsService = new D1AnalyticsService(c.env.ANALYTICS_DB);
    const transitions = await analyticsService.getPageFlowTransitions(orgId, {
      periodStart,
      periodEnd,
      limit
    });

    return success(c, { transitions, source: 'd1' });
  }

  /**
   * Reconstruct page flow transitions from raw R2 SQL events.
   * Used when the requested date range extends beyond D1's 30-day hot window.
   */
  private async reconstructPageFlowFromR2(
    r2sql: R2SQLAdapter,
    orgTag: string,
    periodStart: string,
    periodEnd: string,
    limit: number
  ): Promise<{
    from_id: string; from_name: string | null; from_type: string;
    to_id: string; to_name: string | null;
    visitors_at_from: number; visitors_transitioned: number; transition_rate: number;
    conversions: number; revenue_cents: number;
  }[]> {
    // Fetch page_view events from R2 SQL for the requested period
    // Cap lookback at 90 days — R2 SQL is slow and Analytics Engine retention is 90 days
    const lookbackDays = Math.min(
      Math.ceil((Date.now() - new Date(periodStart).getTime()) / 86_400_000),
      90
    );
    const result = await r2sql.getEvents(orgTag, {
      lookback: `${lookbackDays}d`,
      limit: 5000,
    });

    if (result.error || !result.events?.length) return [];

    // Group by session, build page transitions + source entries
    const sessionMap = new Map<string, typeof result.events>();
    let skippedNoSession = 0;
    for (const ev of result.events) {
      if (ev.event_type !== 'page_view') continue;
      const sid = ev.session_id as string;
      if (!sid) { skippedNoSession++; continue; }
      if (!sessionMap.has(sid)) sessionMap.set(sid, []);
      sessionMap.get(sid)!.push(ev);
    }
    if (skippedNoSession > 0) {
      structuredLog('WARN', 'Page flow R2 fallback: events without session_id skipped', {
        endpoint: 'analytics/d1-metrics',
        step: 'r2-page-flow',
        skipped: skippedNoSession,
        total: result.events.length,
        org_tag: orgTag,
      });
    }

    const pageTransMap = new Map<string, { from: string; to: string; visitors: Set<string> }>();
    const pageVisitors = new Map<string, Set<string>>();
    const sourceEntryMap = new Map<string, { source: string; type: string; page: string; visitors: Set<string> }>();

    for (const [, events] of sessionMap) {
      const views = events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      if (!views.length) continue;
      const anonId = String(views[0].anonymous_id || views[0].session_id);
      const first = views[0];

      // Classify entry source
      let entryLabel: string;
      let entryType: string;
      if (first.gclid) { entryLabel = `Google Ads${first.utm_campaign ? ' / ' + first.utm_campaign : ''}`; entryType = 'source'; }
      else if (first.fbclid) { entryLabel = `Meta Ads${first.utm_campaign ? ' / ' + first.utm_campaign : ''}`; entryType = 'source'; }
      else if (first.ttclid) { entryLabel = `TikTok Ads${first.utm_campaign ? ' / ' + first.utm_campaign : ''}`; entryType = 'source'; }
      else if (first.utm_source) {
        entryLabel = String(first.utm_source);
        if (first.utm_medium) entryLabel += ` / ${first.utm_medium}`;
        if (first.utm_campaign) entryLabel += ` / ${first.utm_campaign}`;
        entryType = 'source';
      } else if (first.referrer_domain) { entryLabel = String(first.referrer_domain); entryType = 'referrer'; }
      else { entryLabel = 'Direct'; entryType = 'source'; }

      const entryPage = String(first.page_path || '/');
      const entryKey = `${entryLabel}→${entryPage}`;
      if (!sourceEntryMap.has(entryKey)) {
        sourceEntryMap.set(entryKey, { source: entryLabel, type: entryType, page: entryPage, visitors: new Set() });
      }
      sourceEntryMap.get(entryKey)!.visitors.add(anonId);

      // Page transitions
      for (let i = 0; i < views.length; i++) {
        const path = String(views[i].page_path || '/');
        if (!pageVisitors.has(path)) pageVisitors.set(path, new Set());
        pageVisitors.get(path)!.add(anonId);

        if (i + 1 < views.length) {
          const nextPath = String(views[i + 1].page_path || '/');
          if (path === nextPath) continue;
          const key = `${path}→${nextPath}`;
          if (!pageTransMap.has(key)) pageTransMap.set(key, { from: path, to: nextPath, visitors: new Set() });
          pageTransMap.get(key)!.visitors.add(anonId);
        }
      }
    }

    // Combine page transitions and source entries, sort by visitors
    const transitions: Array<{
      from_id: string; from_name: string | null; from_type: string;
      to_id: string; to_name: string | null;
      visitors_at_from: number; visitors_transitioned: number; transition_rate: number;
      conversions: number; revenue_cents: number;
    }> = [];

    for (const t of pageTransMap.values()) {
      const fromVis = pageVisitors.get(t.from)?.size || t.visitors.size;
      transitions.push({
        from_id: t.from, from_name: t.from, from_type: 'page_url',
        to_id: t.to, to_name: t.to,
        visitors_at_from: fromVis, visitors_transitioned: t.visitors.size,
        transition_rate: fromVis > 0 ? t.visitors.size / fromVis : 0,
        conversions: 0, revenue_cents: 0,
      });
    }

    for (const s of sourceEntryMap.values()) {
      transitions.push({
        from_id: s.source, from_name: s.source, from_type: s.type,
        to_id: s.page, to_name: s.page,
        visitors_at_from: s.visitors.size, visitors_transitioned: s.visitors.size,
        transition_rate: 1.0,
        conversions: 0, revenue_cents: 0,
      });
    }

    // Sort: source/referrer entries first, then by visitors desc
    transitions.sort((a, b) => {
      const aRank = a.from_type === 'page_url' ? 1 : 0;
      const bRank = b.from_type === 'page_url' ? 1 : 0;
      if (aRank !== bRank) return aRank - bRank;
      return b.visitors_transitioned - a.visitors_transitioned;
    });

    return transitions.slice(0, limit);
  }
}
