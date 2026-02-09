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
  conversion_source: z.enum(['platform', 'tag', 'connector']),
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

    // Query goal_metrics_daily from ANALYTICS_DB
    const result = await c.env.ANALYTICS_DB.prepare(`
      SELECT
        id,
        goal_id,
        summary_date as date,
        conversions,
        conversion_value_cents,
        conversion_rate,
        conversions_platform,
        conversions_tag,
        value_platform_cents,
        value_tag_cents
      FROM goal_metrics_daily
      WHERE organization_id = ?
        AND goal_id = ?
        AND summary_date >= ?
        AND summary_date <= ?
      ORDER BY summary_date DESC
    `).bind(orgId, goalId, dateRange.start_date, dateRange.end_date).all<{
      id: number;
      goal_id: string;
      date: string;
      conversions: number;
      conversion_value_cents: number;
      conversion_rate: number | null;
      conversions_platform: number;
      conversions_tag: number;
      value_platform_cents: number;
      value_tag_cents: number;
    }>();

    const data = result.results.map(row => ({
      id: String(row.id),
      goal_id: row.goal_id,
      date: row.date,
      conversions: row.conversions || 0,
      conversion_value_cents: row.conversion_value_cents || 0,
      conversion_rate: row.conversion_rate,
      conversions_platform: row.conversions_platform || 0,
      conversions_tag: row.conversions_tag || 0,
      value_platform_cents: row.value_platform_cents || 0,
      value_tag_cents: row.value_tag_cents || 0,
    }));

    // Calculate totals
    const totals = data.reduce((acc, row) => ({
      conversions: acc.conversions + row.conversions,
      conversion_value_cents: acc.conversion_value_cents + row.conversion_value_cents,
      conversions_platform: acc.conversions_platform + row.conversions_platform,
      conversions_tag: acc.conversions_tag + row.conversions_tag,
    }), {
      conversions: 0,
      conversion_value_cents: 0,
      conversions_platform: 0,
      conversions_tag: 0,
    });

    console.log(`[GoalMetrics] Query for goal ${goalId} returned ${data.length} records`);

    return success(c, data, {
      goal_id: goalId,
      date_range: {
        start: dateRange.start_date,
        end: dateRange.end_date
      },
      totals
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
    const sourceFilter = c.req.query("source");

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

    // Query goal_conversions from ANALYTICS_DB
    let query = `
      SELECT
        id,
        goal_id,
        conversion_source,
        conversion_timestamp,
        value_cents,
        currency,
        attribution_model,
        attribution_data,
        source_platform
      FROM goal_conversions
      WHERE organization_id = ?
        AND goal_id = ?
    `;
    const params: unknown[] = [orgId, goalId];

    if (sourceFilter && (sourceFilter === 'platform' || sourceFilter === 'tag' || sourceFilter === 'connector')) {
      query += ` AND conversion_source = ?`;
      params.push(sourceFilter);
    }

    query += ` ORDER BY conversion_timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const result = await c.env.ANALYTICS_DB.prepare(query).bind(...params).all<{
      id: string;
      goal_id: string;
      conversion_source: string;
      conversion_timestamp: string;
      value_cents: number;
      currency: string;
      attribution_model: string | null;
      attribution_data: string | null;
      source_platform: string | null;
    }>();

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as count
      FROM goal_conversions
      WHERE organization_id = ?
        AND goal_id = ?
    `;
    const countParams: unknown[] = [orgId, goalId];

    if (sourceFilter && (sourceFilter === 'platform' || sourceFilter === 'tag' || sourceFilter === 'connector')) {
      countQuery += ` AND conversion_source = ?`;
      countParams.push(sourceFilter);
    }

    const countResult = await c.env.ANALYTICS_DB.prepare(countQuery).bind(...countParams).first<{ count: number }>();

    const data = result.results.map(row => ({
      id: row.id,
      goal_id: row.goal_id,
      conversion_source: row.conversion_source as 'platform' | 'tag' | 'connector',
      conversion_timestamp: row.conversion_timestamp,
      value_cents: row.value_cents || 0,
      currency: row.currency || 'USD',
      attribution_model: row.attribution_model,
      attribution_data: row.attribution_data ? JSON.parse(row.attribution_data) : null,
      source_platform: row.source_platform,
    }));

    console.log(`[GoalConversions] Query for goal ${goalId} returned ${data.length} records`);

    return success(c, data, {
      goal_id: goalId,
      count: countResult?.count || 0,
      limit,
      offset
    });
  }
}
