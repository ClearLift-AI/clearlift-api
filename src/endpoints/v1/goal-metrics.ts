import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error, getDateRange } from "../../utils/response";
import { createClient } from "@supabase/supabase-js";
import { getSecret } from "../../utils/secrets";

// ============== Schema Definitions ==============

const GoalMetricsDailySchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  date: z.string(),
  conversions: z.number(),
  conversion_value_cents: z.number(),
  conversion_rate: z.number().nullable(),
  conversions_platform: z.number(),
  conversions_tag: z.number(),
  value_platform_cents: z.number(),
  value_tag_cents: z.number(),
});

const GoalConversionSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  conversion_source: z.enum(['platform', 'tag']),
  conversion_timestamp: z.string(),
  value_cents: z.number(),
  currency: z.string(),
  attribution_model: z.string().nullable(),
  attribution_data: z.record(z.unknown()).nullable(),
  source_platform: z.string().nullable(),
});

// ============== Goal Metrics Endpoints ==============

/**
 * GET /v1/goals/:id/metrics - Get aggregated metrics for a goal
 */
export class GetGoalMetrics extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Get aggregated daily metrics for a goal",
    operationId: "get-goal-metrics",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe("Goal ID")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        end: z.string().optional().describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Daily metrics for the goal",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(GoalMetricsDailySchema),
              meta: z.object({
                goal_id: z.string(),
                date_range: z.object({
                  start: z.string(),
                  end: z.string()
                }),
                totals: z.object({
                  conversions: z.number(),
                  conversion_value_cents: z.number(),
                  conversions_platform: z.number(),
                  conversions_tag: z.number()
                })
              })
            })
          }
        }
      },
      "401": { description: "Unauthorized" },
      "403": { description: "No organization selected" },
      "404": { description: "Goal not found" },
      "500": { description: "Query failed" }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    const goalId = c.req.param("id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    // Get date range from query params or default to last 30 days
    const dateRange = getDateRange(c);

    // Verify goal exists and belongs to org
    const goal = await c.env.DB.prepare(`
      SELECT id FROM conversion_goals WHERE id = ? AND organization_id = ?
    `).bind(goalId, orgId).first();

    if (!goal) {
      return error(c, "NOT_FOUND", "Goal not found", 404);
    }

    // Get Supabase secret key
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase key not configured", 500);
    }

    const supabase = createClient(c.env.SUPABASE_URL, supabaseKey);

    try {
      const { data: metrics, error: queryError } = await supabase
        .from("goal_metrics_daily")
        .select("*")
        .eq("organization_id", orgId)
        .eq("goal_id", goalId)
        .gte("date", dateRange.start_date)
        .lte("date", dateRange.end_date)
        .order("date", { ascending: true });

      if (queryError) {
        console.error("Supabase query error:", queryError);
        return error(c, "QUERY_FAILED", queryError.message, 500);
      }

      // Calculate totals
      const totals = (metrics || []).reduce((acc, m) => ({
        conversions: acc.conversions + (m.conversions || 0),
        conversion_value_cents: acc.conversion_value_cents + (m.conversion_value_cents || 0),
        conversions_platform: acc.conversions_platform + (m.conversions_platform || 0),
        conversions_tag: acc.conversions_tag + (m.conversions_tag || 0),
      }), {
        conversions: 0,
        conversion_value_cents: 0,
        conversions_platform: 0,
        conversions_tag: 0,
      });

      return success(c, metrics || [], {
        goal_id: goalId,
        date_range: {
          start: dateRange.start_date,
          end: dateRange.end_date
        },
        totals
      });
    } catch (err: any) {
      console.error("Goal metrics query error:", err);
      return error(c, "QUERY_FAILED", err.message || "Failed to fetch goal metrics", 500);
    }
  }
}

/**
 * GET /v1/goals/:id/conversions - Get individual conversion events for a goal
 */
export class GetGoalConversions extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Get individual conversion events for a goal",
    operationId: "get-goal-conversions",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe("Goal ID")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        limit: z.coerce.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
        offset: z.coerce.number().int().min(0).optional().describe("Pagination offset"),
        source: z.enum(['platform', 'tag']).optional().describe("Filter by conversion source")
      })
    },
    responses: {
      "200": {
        description: "Individual conversion events",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(GoalConversionSchema),
              meta: z.object({
                goal_id: z.string(),
                count: z.number(),
                limit: z.number(),
                offset: z.number()
              })
            })
          }
        }
      },
      "401": { description: "Unauthorized" },
      "403": { description: "No organization selected" },
      "404": { description: "Goal not found" },
      "500": { description: "Query failed" }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    const goalId = c.req.param("id");
    const limit = parseInt(c.req.query("limit") || "100");
    const offset = parseInt(c.req.query("offset") || "0");
    const source = c.req.query("source");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    // Verify goal exists and belongs to org
    const goal = await c.env.DB.prepare(`
      SELECT id FROM conversion_goals WHERE id = ? AND organization_id = ?
    `).bind(goalId, orgId).first();

    if (!goal) {
      return error(c, "NOT_FOUND", "Goal not found", 404);
    }

    // Get Supabase secret key
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase key not configured", 500);
    }

    const supabase = createClient(c.env.SUPABASE_URL, supabaseKey);

    try {
      let query = supabase
        .from("goal_conversions")
        .select("*", { count: "exact" })
        .eq("organization_id", orgId)
        .eq("goal_id", goalId)
        .order("conversion_timestamp", { ascending: false })
        .range(offset, offset + limit - 1);

      // Filter by source if specified
      if (source) {
        query = query.eq("conversion_source", source);
      }

      const { data: conversions, count, error: queryError } = await query;

      if (queryError) {
        console.error("Supabase query error:", queryError);
        return error(c, "QUERY_FAILED", queryError.message, 500);
      }

      return success(c, conversions || [], {
        goal_id: goalId,
        count: count || 0,
        limit,
        offset
      });
    } catch (err: any) {
      console.error("Goal conversions query error:", err);
      return error(c, "QUERY_FAILED", err.message || "Failed to fetch goal conversions", 500);
    }
  }
}
