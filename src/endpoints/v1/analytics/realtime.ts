/**
 * Real-time Analytics Endpoints
 *
 * Uses Cloudflare Analytics Engine for sub-second query latency.
 * Data is written from clearlift-events worker via writeDataPoint().
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { AnalyticsEngineService } from "../../../services/analytics-engine";

/**
 * GET /v1/analytics/realtime/summary
 * Get real-time analytics summary (last N hours)
 */
export class GetRealtimeSummary extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get real-time analytics summary",
    description: "Returns aggregated metrics from Analytics Engine for the specified time window",
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
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    // Get API token from secrets store (use R2_SQL_TOKEN as fallback)
    const apiToken = typeof c.env.R2_SQL_TOKEN === 'string'
      ? c.env.R2_SQL_TOKEN
      : await (c.env.R2_SQL_TOKEN as any)?.get();
    if (!apiToken) {
      return error(c, "CONFIG_ERROR", "Analytics Engine not configured", 500);
    }

    const analytics = new AnalyticsEngineService(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken
    );

    try {
      const summary = await analytics.getSummary(orgTagMapping.short_tag, hours);
      return success(c, summary);
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
    const interval = (c.req.query("interval") || "hour") as "hour" | "15min";

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const apiToken = typeof c.env.R2_SQL_TOKEN === 'string'
      ? c.env.R2_SQL_TOKEN
      : await (c.env.R2_SQL_TOKEN as any)?.get();
    if (!apiToken) {
      return error(c, "CONFIG_ERROR", "Analytics Engine not configured", 500);
    }

    const analytics = new AnalyticsEngineService(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken
    );

    try {
      const data = await analytics.getTimeSeries(orgTagMapping.short_tag, hours, interval);
      return success(c, data);
    } catch (err) {
      console.error('[Realtime] Time series query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/breakdown
 * Get breakdown by dimension
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
        dimension: z.enum(["utm_source", "utm_medium", "utm_campaign", "device", "country", "page", "browser"]).describe("Dimension to group by"),
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
    const dimension = c.req.query("dimension") as any;
    const hours = parseInt(c.req.query("hours") || "24");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    if (!dimension) {
      return error(c, "MISSING_DIMENSION", "Dimension parameter is required", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const apiToken = typeof c.env.R2_SQL_TOKEN === 'string'
      ? c.env.R2_SQL_TOKEN
      : await (c.env.R2_SQL_TOKEN as any)?.get();
    if (!apiToken) {
      return error(c, "CONFIG_ERROR", "Analytics Engine not configured", 500);
    }

    const analytics = new AnalyticsEngineService(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken
    );

    try {
      const data = await analytics.getBreakdown(orgTagMapping.short_tag, dimension, hours);
      return success(c, data);
    } catch (err) {
      console.error('[Realtime] Breakdown query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}

/**
 * GET /v1/analytics/realtime/events
 * Get recent events (live feed)
 */
export class GetRealtimeEvents extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get recent events (live feed)",
    description: "Returns the most recent events for a live dashboard feed",
    operationId: "get-realtime-events",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        minutes: z.coerce.number().int().min(1).max(60).optional().default(5).describe("Minutes to look back"),
        limit: z.coerce.number().int().min(1).max(1000).optional().default(100).describe("Maximum events to return")
      })
    },
    responses: {
      "200": {
        description: "Recent events",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                timestamp: z.string(),
                event_type: z.string(),
                page_path: z.string().optional(),
                device_type: z.string().optional(),
                country: z.string().optional(),
                utm_source: z.string().optional(),
                is_conversion: z.number().optional(),
                goal_value: z.number().optional()
              }))
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const minutes = parseInt(c.req.query("minutes") || "5");
    const limit = parseInt(c.req.query("limit") || "100");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const orgTagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const apiToken = typeof c.env.R2_SQL_TOKEN === 'string'
      ? c.env.R2_SQL_TOKEN
      : await (c.env.R2_SQL_TOKEN as any)?.get();
    if (!apiToken) {
      return error(c, "CONFIG_ERROR", "Analytics Engine not configured", 500);
    }

    const analytics = new AnalyticsEngineService(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken
    );

    try {
      const data = await analytics.getRecentEvents(orgTagMapping.short_tag, minutes, limit);
      return success(c, data);
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
    `).bind(orgId).first<{ short_tag: string }>();

    if (!orgTagMapping?.short_tag) {
      return error(c, "NO_ORG_TAG", "Organization not configured for analytics", 404);
    }

    const apiToken = typeof c.env.R2_SQL_TOKEN === 'string'
      ? c.env.R2_SQL_TOKEN
      : await (c.env.R2_SQL_TOKEN as any)?.get();
    if (!apiToken) {
      return error(c, "CONFIG_ERROR", "Analytics Engine not configured", 500);
    }

    const analytics = new AnalyticsEngineService(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken
    );

    try {
      const data = await analytics.getEventTypes(orgTagMapping.short_tag, hours);
      return success(c, data);
    } catch (err) {
      console.error('[Realtime] Event types query failed:', err);
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Query failed", 500);
    }
  }
}
