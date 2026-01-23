/**
 * Real-time Analytics Endpoints
 *
 * Uses D1 hourly_metrics table for fast queries.
 * Data is aggregated from events by the events-sync workflow.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";

/**
 * GET /v1/analytics/realtime/summary
 * Get real-time analytics summary (last N hours)
 */
export class GetRealtimeSummary extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get real-time analytics summary",
    description: "Returns aggregated metrics from D1 for the specified time window",
    operationId: "get-realtime-summary",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID (uses session org if not provided)"),
        hours: z.coerce.number().int().min(1).max(168).optional().default(24).describe("Hours to look back (default: 24, max: 168)")
      })
    },
    responses: {
      "200": {
        description: "Real-time analytics summary",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                totalEvents: z.number(),
                sessions: z.number(),
                users: z.number(),
                conversions: z.number(),
                revenue: z.number(),
                pageViews: z.number()
              })
            })
          }
        }
      },
      "404": { description: "Organization not found or not configured" }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const hours = parseInt(c.req.query("hours") || "24");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    // Get org_tag from mapping
    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first() as { short_tag: string } | null;

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Query hourly_metrics for the last N hours
      const result = await analyticsDb.prepare(`
        SELECT
          COALESCE(SUM(total_events), 0) as total_events,
          COALESCE(SUM(sessions), 0) as sessions,
          COALESCE(SUM(users), 0) as users,
          COALESCE(SUM(conversions), 0) as conversions,
          COALESCE(SUM(revenue_cents), 0) as revenue_cents,
          COALESCE(SUM(page_views), 0) as page_views
        FROM hourly_metrics
        WHERE org_tag = ?
          AND hour >= datetime('now', '-' || ? || ' hours')
      `).bind(orgTagMapping.short_tag, hours).first() as {
        total_events: number;
        sessions: number;
        users: number;
        conversions: number;
        revenue_cents: number;
        page_views: number;
      } | null;

      return success(c, {
        totalEvents: result?.total_events || 0,
        sessions: result?.sessions || 0,
        users: result?.users || 0,
        conversions: result?.conversions || 0,
        revenue: (result?.revenue_cents || 0) / 100,
        pageViews: result?.page_views || 0
      });
    } catch (err) {
      console.error('[Realtime] Summary query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/timeseries
 * Get time series data for charts
 */
export class GetRealtimeTimeSeries extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get real-time time series data",
    description: "Returns time-bucketed metrics for charting",
    operationId: "get-realtime-timeseries",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        hours: z.coerce.number().int().min(1).max(168).optional().default(24).describe("Hours to look back"),
        interval: z.enum(["hour", "15min"]).optional().default("hour").describe("Time bucket interval")
      })
    },
    responses: {
      "200": {
        description: "Time series data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                bucket: z.string(),
                events: z.number(),
                sessions: z.number(),
                pageViews: z.number(),
                conversions: z.number()
              }))
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const hours = parseInt(c.req.query("hours") || "24");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first() as { short_tag: string } | null;

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Query hourly_metrics for time series
      interface TimeSeriesRow {
        bucket: string;
        events: number;
        sessions: number;
        page_views: number;
        conversions: number;
      }
      const result = await analyticsDb.prepare(`
        SELECT
          hour as bucket,
          total_events as events,
          sessions,
          page_views,
          conversions
        FROM hourly_metrics
        WHERE org_tag = ?
          AND hour >= datetime('now', '-' || ? || ' hours')
        ORDER BY hour ASC
      `).bind(orgTagMapping.short_tag, hours).all();

      return success(c, ((result.results || []) as TimeSeriesRow[]).map((row: TimeSeriesRow) => ({
        bucket: row.bucket,
        events: row.events || 0,
        sessions: row.sessions || 0,
        pageViews: row.page_views || 0,
        conversions: row.conversions || 0
      })));
    } catch (err) {
      console.error('[Realtime] Time series query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/breakdown
 * Get breakdown by dimension (uses by_channel JSON field)
 */
export class GetRealtimeBreakdown extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get real-time breakdown by dimension",
    description: "Returns metrics grouped by the specified dimension",
    operationId: "get-realtime-breakdown",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        dimension: z.enum(["utm_source", "utm_medium", "utm_campaign", "device", "country", "page", "browser", "channel"]).describe("Dimension to group by"),
        hours: z.coerce.number().int().min(1).max(168).optional().default(24).describe("Hours to look back")
      })
    },
    responses: {
      "200": {
        description: "Breakdown data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                dimension: z.string(),
                events: z.number(),
                sessions: z.number(),
                conversions: z.number(),
                revenue: z.number()
              }))
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const dimension = c.req.query("dimension") as string;
    const hours = parseInt(c.req.query("hours") || "24");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    if (!dimension) {
      return error(c, "MISSING_DIMENSION", "Dimension parameter is required", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first() as { short_tag: string } | null;

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // For channel/device breakdowns, use the JSON fields in hourly_metrics
      if (dimension === 'channel' || dimension === 'utm_source') {
        const result = await analyticsDb.prepare(`
          SELECT by_channel FROM hourly_metrics
          WHERE org_tag = ?
            AND hour >= datetime('now', '-' || ? || ' hours')
            AND by_channel IS NOT NULL
        `).bind(orgTagMapping.short_tag, hours).all();

        // Aggregate the JSON data
        const aggregated: Record<string, { events: number; sessions: number; conversions: number; revenue: number }> = {};

        for (const row of (result.results || []) as { by_channel: string }[]) {
          try {
            const channels = JSON.parse(row.by_channel || '{}');
            for (const [channel, data] of Object.entries(channels as Record<string, any>)) {
              if (!aggregated[channel]) {
                aggregated[channel] = { events: 0, sessions: 0, conversions: 0, revenue: 0 };
              }
              // Handle both formats: simple count (number) or object with events property
              if (typeof data === 'number') {
                aggregated[channel].events += data;
              } else {
                aggregated[channel].events += data.events || 0;
                aggregated[channel].sessions += data.sessions || 0;
                aggregated[channel].conversions += data.conversions || 0;
                aggregated[channel].revenue += (data.revenue_cents || 0) / 100;
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }

        return success(c, Object.entries(aggregated)
          .map(([dim, data]) => ({ dimension: dim, ...data }))
          .sort((a, b) => b.events - a.events)
          .slice(0, 50)
        );
      }

      if (dimension === 'device') {
        const result = await analyticsDb.prepare(`
          SELECT by_device FROM hourly_metrics
          WHERE org_tag = ?
            AND hour >= datetime('now', '-' || ? || ' hours')
            AND by_device IS NOT NULL
        `).bind(orgTagMapping.short_tag, hours).all();

        const aggregated: Record<string, { events: number; sessions: number; conversions: number; revenue: number }> = {};

        for (const row of (result.results || []) as { by_device: string }[]) {
          try {
            const devices = JSON.parse(row.by_device || '{}');
            for (const [device, data] of Object.entries(devices as Record<string, any>)) {
              if (!aggregated[device]) {
                aggregated[device] = { events: 0, sessions: 0, conversions: 0, revenue: 0 };
              }
              // Handle both formats: simple count (number) or object with events property
              if (typeof data === 'number') {
                aggregated[device].events += data;
              } else {
                aggregated[device].events += data.events || 0;
                aggregated[device].sessions += data.sessions || 0;
                aggregated[device].conversions += data.conversions || 0;
                aggregated[device].revenue += (data.revenue_cents || 0) / 100;
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }

        return success(c, Object.entries(aggregated)
          .map(([dim, data]) => ({ dimension: dim, ...data }))
          .sort((a, b) => b.events - a.events)
          .slice(0, 50)
        );
      }

      // For page breakdown, use by_page JSON column in hourly_metrics
      // Note: by_page stores simple counts like { "/page": 5 } not objects
      if (dimension === 'page') {
        const result = await analyticsDb.prepare(`
          SELECT by_page FROM hourly_metrics
          WHERE org_tag = ?
            AND hour >= datetime('now', '-' || ? || ' hours')
            AND by_page IS NOT NULL
        `).bind(orgTagMapping.short_tag, hours).all();

        const aggregated: Record<string, { events: number; sessions: number; conversions: number; revenue: number }> = {};

        for (const row of (result.results || []) as { by_page: string }[]) {
          try {
            const pages = JSON.parse(row.by_page || '{}');
            for (const [page, data] of Object.entries(pages as Record<string, any>)) {
              if (!aggregated[page]) {
                aggregated[page] = { events: 0, sessions: 0, conversions: 0, revenue: 0 };
              }
              // Handle both formats: simple count (number) or object with events property
              if (typeof data === 'number') {
                aggregated[page].events += data;
              } else {
                aggregated[page].events += data.events || data.count || 0;
                aggregated[page].sessions += data.sessions || 0;
                aggregated[page].conversions += data.conversions || 0;
                aggregated[page].revenue += (data.revenue_cents || 0) / 100;
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }

        return success(c, Object.entries(aggregated)
          .map(([dim, data]) => ({ dimension: dim, ...data }))
          .sort((a, b) => b.events - a.events)
          .slice(0, 50)
        );
      }

      // For utm_medium, utm_campaign, country, browser - not yet implemented
      // Would need additional JSON columns or Analytics Engine API token
      return success(c, []);
    } catch (err) {
      console.error('[Realtime] Breakdown query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/events
 * Get recent events (from hourly aggregates - not individual events)
 */
export class GetRealtimeEvents extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get recent events summary",
    description: "Returns recent hourly event summaries",
    operationId: "get-realtime-events",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        minutes: z.coerce.number().int().min(1).max(60).optional().default(5).describe("Minutes to look back (returns hourly data)"),
        limit: z.coerce.number().int().min(1).max(1000).optional().default(100).describe("Maximum records to return")
      })
    },
    responses: {
      "200": {
        description: "Recent event summaries",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                timestamp: z.string(),
                total_events: z.number(),
                page_views: z.number(),
                sessions: z.number(),
                conversions: z.number()
              }))
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const limit = parseInt(c.req.query("limit") || "100");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first() as { short_tag: string } | null;

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Return recent hourly summaries
      const result = await analyticsDb.prepare(`
        SELECT
          hour as timestamp,
          total_events,
          page_views,
          sessions,
          conversions
        FROM hourly_metrics
        WHERE org_tag = ?
        ORDER BY hour DESC
        LIMIT ?
      `).bind(orgTagMapping.short_tag, limit).all();

      return success(c, result.results || []);
    } catch (err) {
      console.error('[Realtime] Recent events query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/event-types
 * Get event types breakdown
 */
export class GetRealtimeEventTypes extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get event types breakdown",
    description: "Returns metrics grouped by event type",
    operationId: "get-realtime-event-types",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        hours: z.coerce.number().int().min(1).max(168).optional().default(24).describe("Hours to look back")
      })
    },
    responses: {
      "200": {
        description: "Event types data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                dimension: z.string(),
                events: z.number(),
                sessions: z.number(),
                conversions: z.number(),
                revenue: z.number()
              }))
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const hours = parseInt(c.req.query("hours") || "24");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first() as { short_tag: string } | null;

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Return aggregated event types from hourly_metrics
      const result = await analyticsDb.prepare(`
        SELECT
          COALESCE(SUM(page_views), 0) as page_views,
          COALESCE(SUM(clicks), 0) as clicks,
          COALESCE(SUM(form_submits), 0) as form_submits,
          COALESCE(SUM(custom_events), 0) as custom_events,
          COALESCE(SUM(conversions), 0) as conversions,
          COALESCE(SUM(revenue_cents), 0) as revenue_cents
        FROM hourly_metrics
        WHERE org_tag = ?
          AND hour >= datetime('now', '-' || ? || ' hours')
      `).bind(orgTagMapping.short_tag, hours).first() as {
        page_views: number;
        clicks: number;
        form_submits: number;
        custom_events: number;
        conversions: number;
        revenue_cents: number;
      } | null;

      const eventTypes = [
        { dimension: 'page_view', events: result?.page_views || 0, sessions: 0, conversions: 0, revenue: 0 },
        { dimension: 'click', events: result?.clicks || 0, sessions: 0, conversions: 0, revenue: 0 },
        { dimension: 'form_submit', events: result?.form_submits || 0, sessions: 0, conversions: 0, revenue: 0 },
        { dimension: 'custom', events: result?.custom_events || 0, sessions: 0, conversions: 0, revenue: 0 },
        { dimension: 'conversion', events: result?.conversions || 0, sessions: 0, conversions: result?.conversions || 0, revenue: (result?.revenue_cents || 0) / 100 },
      ].filter(e => e.events > 0).sort((a, b) => b.events - a.events);

      return success(c, eventTypes);
    } catch (err) {
      console.error('[Realtime] Event types query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/revenue
 * Get real-time revenue analytics from all connected revenue sources
 * Uses the plugin system to query Stripe, Shopify, Jobber, and future connectors
 * Respects the org's disabled_conversion_sources setting
 */
export class GetRealtimeStripe extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get real-time revenue analytics",
    description: "Returns combined conversions and revenue from all connected revenue sources (Stripe, Shopify, Jobber, etc.) for the specified time window.",
    operationId: "get-realtime-revenue",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        hours: z.coerce.number().int().min(1).max(168).optional().default(24).describe("Hours to look back")
      })
    },
    responses: {
      "200": {
        description: "Real-time revenue analytics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                summary: z.object({
                  conversions: z.number().describe("Total successful transactions"),
                  revenue: z.number().describe("Total revenue from all sources"),
                  uniqueCustomers: z.number().describe("Unique customers in time window"),
                  sources: z.record(z.object({
                    conversions: z.number(),
                    revenue: z.number(),
                    displayName: z.string()
                  })).describe("Per-source breakdown")
                }),
                timeSeries: z.array(z.object({
                  bucket: z.string(),
                  conversions: z.number(),
                  revenue: z.number()
                })),
                availableSources: z.array(z.object({
                  platform: z.string(),
                  displayName: z.string(),
                  conversionLabel: z.string()
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
    const hours = parseInt(c.req.query("hours") || "24");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Get org's disabled conversion sources from settings
      let disabledSources: string[] = [];
      try {
        const settings = await c.env.DB.prepare(`
          SELECT disabled_conversion_sources FROM ai_optimization_settings WHERE org_id = ?
        `).bind(orgId).first() as { disabled_conversion_sources: string | null } | null;

        if (settings?.disabled_conversion_sources) {
          disabledSources = JSON.parse(settings.disabled_conversion_sources);
        }
      } catch (e) {
        // Settings may not exist, use empty disabled list
      }

      // Import and use the revenue source plugin system
      const { getCombinedRevenue } = await import("../../../services/revenue-sources/providers");
      const result = await getCombinedRevenue(analyticsDb, orgId, hours, disabledSources);

      return success(c, result);
    } catch (err) {
      console.error('[Realtime] Revenue query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/goals
 * Get real-time metrics for all configured conversion goals
 * Supports multiple goals with different sources (revenue_source, tag_event, etc.)
 */
export class GetRealtimeGoals extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get real-time metrics for all conversion goals",
    description: "Returns conversion and revenue metrics for all active goals configured for the organization. Supports goals backed by revenue sources (Stripe, Shopify, Jobber), tag events, or manual logging.",
    operationId: "get-realtime-goals",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        hours: z.coerce.number().int().min(1).max(168).optional().default(24).describe("Hours to look back"),
        goal_id: z.string().optional().describe("Filter to specific goal ID (optional)")
      })
    },
    responses: {
      "200": {
        description: "Real-time goal metrics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                goals: z.array(z.object({
                  goal_id: z.string(),
                  goal_name: z.string(),
                  goal_slug: z.string(),
                  goal_type: z.enum(['revenue_source', 'tag_event', 'manual']),
                  is_primary: z.boolean(),
                  color: z.string().optional(),
                  icon: z.string().optional(),
                  conversions: z.number(),
                  revenue: z.number(),
                  unique_customers: z.number().optional(),
                  sources: z.record(z.object({
                    conversions: z.number(),
                    revenue: z.number()
                  })).optional()
                })),
                primary_goal: z.object({
                  goal_id: z.string(),
                  goal_name: z.string(),
                  conversions: z.number(),
                  revenue: z.number()
                }).optional(),
                total_conversions: z.number(),
                total_revenue: z.number()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const hours = parseInt(c.req.query("hours") || "24");
    const goalIdFilter = c.req.query("goal_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Import the goal service
      const { GoalService } = await import("../../../services/goals");
      const goalService = new GoalService(c.env.DB, analyticsDb);

      // Get all goals or specific goal
      if (goalIdFilter) {
        const goal = await goalService.getGoal(orgId, goalIdFilter);
        if (!goal) {
          return error(c, "NOT_FOUND", "Goal not found", 404);
        }
        const metrics = await goalService.getGoalRealtimeMetrics(orgId, goal, hours);
        return success(c, {
          goals: [metrics],
          primary_goal: goal.is_primary ? metrics : undefined,
          total_conversions: metrics.conversions,
          total_revenue: metrics.revenue,
        });
      }

      // Get metrics for all active goals
      const allMetrics = await goalService.getRealtimeMetrics(orgId, hours);
      return success(c, allMetrics);
    } catch (err) {
      console.error('[Realtime] Goals query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/goals/:id/timeseries
 * Get time series data for a specific goal
 */
export class GetRealtimeGoalTimeSeries extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get time series for a conversion goal",
    description: "Returns hourly time series data for a specific goal",
    operationId: "get-realtime-goal-timeseries",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe("Goal ID")
      }),
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        hours: z.coerce.number().int().min(1).max(168).optional().default(24).describe("Hours to look back")
      })
    },
    responses: {
      "200": {
        description: "Goal time series data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                bucket: z.string(),
                conversions: z.number(),
                revenue: z.number()
              }))
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const goalId = c.req.param("id");
    const hours = parseInt(c.req.query("hours") || "24");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const analyticsDb = (c.env as any).ANALYTICS_DB;
    if (!analyticsDb) {
      return error(c, "CONFIG_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      const { GoalService } = await import("../../../services/goals");
      const goalService = new GoalService(c.env.DB, analyticsDb);

      const timeSeries = await goalService.getGoalTimeSeries(orgId, goalId, hours);
      return success(c, timeSeries);
    } catch (err) {
      console.error('[Realtime] Goal time series query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}
