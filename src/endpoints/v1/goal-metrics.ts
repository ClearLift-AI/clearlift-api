import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error, getDateRange } from "../../utils/response";

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
 *
 * NOTE: Requires goal_metrics_daily table to be populated in D1 ANALYTICS_DB
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

    // TODO: Query goal_metrics_daily from D1 when table is available
    // For now, return empty results as this table needs to be created
    // and populated in D1 ANALYTICS_DB.

    console.log(`[GoalMetrics] Query for goal ${goalId} - returning empty (D1 table not yet populated)`);

    return success(c, [], {
      goal_id: goalId,
      date_range: {
        start: dateRange.start_date,
        end: dateRange.end_date
      },
      totals: {
        conversions: 0,
        conversion_value_cents: 0,
        conversions_platform: 0,
        conversions_tag: 0,
      }
    });
  }
}

/**
 * GET /v1/goals/:id/conversions - Get individual conversion events for a goal
 *
 * NOTE: Requires goal_conversions table to be populated in D1 ANALYTICS_DB
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

    // TODO: Query goal_conversions from D1 when table is available
    // For now, return empty results as this table needs to be created
    // and populated in D1 ANALYTICS_DB.

    console.log(`[GoalConversions] Query for goal ${goalId} - returning empty (D1 table not yet populated)`);

    return success(c, [], {
      goal_id: goalId,
      count: 0,
      limit,
      offset
    });
  }
}
