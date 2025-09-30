import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { Session } from "../../../middleware/auth";
import { D1Adapter } from "../../../adapters/d1";
import { R2SQLAdapter } from "../../../adapters/platforms/r2sql";
import { success, error } from "../../../utils/response";

/**
 * GET /v1/analytics/conversions - Get conversion events from R2 SQL
 */
export class GetConversions extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get conversion events",
    description: "Fetches conversion events from R2 SQL using the organization's tag mapping",
    operationId: "get-conversions",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        lookback: z.string().optional().describe("Time period: 1h, 24h, 7d, 30d"),
        event_type: z.string().optional().describe("Filter by event type"),
        limit: z.string().optional().describe("Maximum number of events")
      })
    },
    responses: {
      "200": {
        description: "Conversion events",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                events: z.array(z.any()),
                summary: z.object({
                  total_events: z.number(),
                  unique_users: z.number(),
                  total_value: z.number(),
                  events_by_type: z.record(z.number()),
                  top_sources: z.array(z.object({
                    source: z.string(),
                    count: z.number()
                  }))
                })
              }),
              meta: z.object({
                timestamp: z.string(),
                lookback: z.string(),
                org_tag: z.string()
              })
            })
          }
        }
      },
      "403": { description: "No organization selected or no tag mapping" },
      "500": { description: "Query failed" }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    // Get organization's tag from mapping
    const d1 = new D1Adapter(c.env.DB);
    const orgTag = await d1.getOrgTag(orgId);

    if (!orgTag) {
      return error(
        c,
        "NO_TAG_MAPPING",
        "Organization has no tag mapping for analytics access",
        403
      );
    }

    // Get query parameters
    const lookback = c.req.query("lookback") || "7d";
    const eventType = c.req.query("event_type");
    const limit = parseInt(c.req.query("limit") || "100");

    // Create R2 SQL adapter
    const r2sql = new R2SQLAdapter(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.R2_BUCKET_NAME,
      c.env.R2_SQL_TOKEN
    );

    try {
      // Build query options
      const options = {
        lookback,
        filters: eventType ? { eventType } : undefined,
        limit
      };

      // Fetch events with summary
      const result = await r2sql.getEventsWithSummary(orgTag, options);

      if (result.error) {
        return error(c, "QUERY_FAILED", result.error, 500);
      }

      return success(
        c,
        {
          events: result.events,
          summary: result.summary
        },
        {
          lookback,
          org_tag: orgTag
        }
      );
    } catch (err) {
      console.error("Failed to fetch conversions:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch conversion data", 500);
    }
  }
}

/**
 * GET /v1/analytics/stats - Get aggregated statistics
 */
export class GetAnalyticsStats extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get analytics statistics",
    description: "Fetches aggregated statistics from R2 SQL",
    operationId: "get-analytics-stats",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        lookback: z.string().optional().describe("Time period: 1h, 24h, 7d, 30d")
      })
    },
    responses: {
      "200": {
        description: "Analytics statistics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.any()
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const d1 = new D1Adapter(c.env.DB);
    const orgTag = await d1.getOrgTag(orgId);

    if (!orgTag) {
      return error(c, "NO_TAG_MAPPING", "No analytics access", 403);
    }

    const lookback = c.req.query("lookback") || "7d";

    const r2sql = new R2SQLAdapter(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.R2_BUCKET_NAME,
      c.env.R2_SQL_TOKEN
    );

    try {
      const stats = await r2sql.getStats(orgTag, lookback);

      if (stats.error) {
        return error(c, "QUERY_FAILED", stats.error, 500);
      }

      return success(c, stats);
    } catch (err) {
      console.error("Failed to fetch stats:", err);
      return error(c, "QUERY_FAILED", "Failed to fetch statistics", 500);
    }
  }
}

/**
 * GET /v1/analytics/funnel - Get conversion funnel
 */
export class GetConversionFunnel extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get conversion funnel",
    description: "Calculate conversion funnel for specified event steps",
    operationId: "get-conversion-funnel",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        steps: z.string().describe("Comma-separated event types"),
        lookback: z.string().optional().describe("Time period")
      })
    },
    responses: {
      "200": {
        description: "Funnel data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                steps: z.array(z.any()),
                conversion_rates: z.array(z.number()),
                overall_conversion: z.number()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const stepsParam = c.req.query("steps");
    if (!stepsParam) {
      return error(c, "INVALID_REQUEST", "Steps parameter is required", 400);
    }

    const steps = stepsParam.split(",").map((s) => s.trim());
    const lookback = c.req.query("lookback") || "7d";

    const d1 = new D1Adapter(c.env.DB);
    const orgTag = await d1.getOrgTag(orgId);

    if (!orgTag) {
      return error(c, "NO_TAG_MAPPING", "No analytics access", 403);
    }

    const r2sql = new R2SQLAdapter(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.R2_BUCKET_NAME,
      c.env.R2_SQL_TOKEN
    );

    try {
      const funnel = await r2sql.getFunnel(orgTag, steps, lookback);

      if (funnel.error) {
        return error(c, "QUERY_FAILED", funnel.error, 500);
      }

      return success(c, funnel);
    } catch (err) {
      console.error("Failed to fetch funnel:", err);
      return error(c, "QUERY_FAILED", "Failed to calculate funnel", 500);
    }
  }
}