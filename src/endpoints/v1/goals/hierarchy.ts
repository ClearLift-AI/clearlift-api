/**
 * Goal Hierarchy API Endpoints
 *
 * Manages goal relationships and automatic value computation
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { GoalValueComputationService } from "../../../services/goal-value-computation";
import { structuredLog } from "../../../utils/structured-logger";

/**
 * GET /v1/goals/hierarchy
 * Get full goal hierarchy with computed values
 */
export class GetGoalHierarchy extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Get goal hierarchy",
    description: "Returns goal hierarchy with parent-child relationships and computed values",
    operationId: "get-goal-hierarchy",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
      }),
    },
    responses: {
      "200": {
        description: "Goal hierarchy",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                hierarchy: z.array(z.any()),
                summary: z.object({
                  total_goals: z.number(),
                  macro_conversions: z.number(),
                  micro_conversions: z.number(),
                  engagement_goals: z.number(),
                }),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    try {
      const service = new GoalValueComputationService(c.env.DB, (c.env as any).ANALYTICS_DB);
      const hierarchy = await service.getGoalHierarchy(orgId);

      // Count goals by category
      const allGoals = await c.env.DB.prepare(`
        SELECT category, COUNT(*) as count
        FROM conversion_goals
        WHERE organization_id = ? AND is_active = 1
        GROUP BY category
      `).bind(orgId).all<{ category: string; count: number }>();

      const counts = {
        macro_conversion: 0,
        micro_conversion: 0,
        engagement: 0,
      };

      for (const row of allGoals.results || []) {
        if (row.category in counts) {
          counts[row.category as keyof typeof counts] = row.count;
        }
      }

      return success(c, {
        hierarchy,
        summary: {
          total_goals: counts.macro_conversion + counts.micro_conversion + counts.engagement,
          macro_conversions: counts.macro_conversion,
          micro_conversions: counts.micro_conversion,
          engagement_goals: counts.engagement,
        },
      });
    } catch (err) {
      structuredLog('ERROR', 'Failed to get goal hierarchy', { endpoint: 'GET /v1/goals/hierarchy', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Failed to get hierarchy", 500);
    }
  }
}

/**
 * POST /v1/goals/relationships
 * Create a relationship between two goals
 */
export class CreateGoalRelationship extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Create goal relationship",
    description: "Links an upstream goal (e.g., checkout page) to a downstream goal (e.g., purchase)",
    operationId: "create-goal-relationship",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              upstream_goal_id: z.string().describe("The earlier goal in the funnel"),
              downstream_goal_id: z.string().describe("The later goal (usually macro-conversion)"),
              relationship_type: z.enum(["funnel", "correlated"]).default("funnel"),
              funnel_position: z.number().int().min(1).optional().describe("Position in funnel (1 = closest to conversion)"),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Relationship created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                id: z.string(),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const body = await c.req.json();

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const { upstream_goal_id, downstream_goal_id, relationship_type, funnel_position } = body;

    // Verify both goals exist and belong to org
    const [upstream, downstream] = await Promise.all([
      c.env.DB.prepare(`SELECT id FROM conversion_goals WHERE id = ? AND organization_id = ?`)
        .bind(upstream_goal_id, orgId).first(),
      c.env.DB.prepare(`SELECT id FROM conversion_goals WHERE id = ? AND organization_id = ?`)
        .bind(downstream_goal_id, orgId).first(),
    ]);

    if (!upstream || !downstream) {
      return error(c, "GOAL_NOT_FOUND", "One or both goals not found", 404);
    }

    // Check for existing relationship
    const existing = await c.env.DB.prepare(`
      SELECT id FROM goal_relationships
      WHERE organization_id = ? AND upstream_goal_id = ? AND downstream_goal_id = ?
    `).bind(orgId, upstream_goal_id, downstream_goal_id).first();

    if (existing) {
      return error(c, "RELATIONSHIP_EXISTS", "Relationship already exists", 409);
    }

    const id = crypto.randomUUID();

    await c.env.DB.prepare(`
      INSERT INTO goal_relationships (id, organization_id, upstream_goal_id, downstream_goal_id, relationship_type, funnel_position)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, orgId, upstream_goal_id, downstream_goal_id, relationship_type, funnel_position || null).run();

    return success(c, { id });
  }
}

/**
 * DELETE /v1/goals/relationships/:id
 * Delete a goal relationship
 */
export class DeleteGoalRelationship extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Delete goal relationship",
    operationId: "delete-goal-relationship",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe("Relationship ID"),
      }),
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
      }),
    },
    responses: {
      "200": {
        description: "Relationship deleted",
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const { id } = c.req.param() as { id: string };

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    await c.env.DB.prepare(`
      DELETE FROM goal_relationships WHERE id = ? AND organization_id = ?
    `).bind(id, orgId).run();

    return success(c, { deleted: true });
  }
}

/**
 * POST /v1/goals/:id/compute-value
 * Compute and update the value for a specific goal
 */
export class ComputeGoalValue extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Compute goal value",
    description: "Calculates expected value based on conversion probability to downstream goals",
    operationId: "compute-goal-value",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe("Goal ID"),
      }),
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        method: z.enum(["expected_value", "funnel_position", "bayesian"]).optional().default("expected_value"),
      }),
    },
    responses: {
      "200": {
        description: "Computed value",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                goal_id: z.string(),
                value_method: z.string(),
                computed_value_cents: z.number(),
                confidence_lower_cents: z.number(),
                confidence_upper_cents: z.number(),
                sample_size: z.number(),
                computation_details: z.any(),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const { id } = c.req.param() as { id: string };
    const method = c.req.query("method") || "expected_value";

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    try {
      const service = new GoalValueComputationService(c.env.DB, (c.env as any).ANALYTICS_DB);

      let result;
      if (method === "funnel_position") {
        result = await service.computeFunnelPositionValue(orgId, id);
      } else {
        result = await service.computeExpectedValue(orgId, id);
      }

      // Update the goal with computed value
      await c.env.DB.prepare(`
        UPDATE conversion_goals
        SET computed_value_cents = ?,
            computed_value_lower_cents = ?,
            computed_value_upper_cents = ?,
            value_computed_at = datetime('now')
        WHERE id = ? AND organization_id = ?
      `).bind(
        result.computed_value_cents,
        result.confidence_lower_cents,
        result.confidence_upper_cents,
        id,
        orgId
      ).run();

      return success(c, result);
    } catch (err) {
      structuredLog('ERROR', 'Failed to compute goal value', { endpoint: 'POST /v1/goals/:id/compute-value', error: err instanceof Error ? err.message : String(err) });
      return error(c, "COMPUTATION_FAILED", err instanceof Error ? err.message : "Failed to compute value", 500);
    }
  }
}

/**
 * POST /v1/goals/recompute-all
 * Recompute values for all auto-compute goals
 */
export class RecomputeAllGoalValues extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Recompute all goal values",
    description: "Recalculates values for all goals with auto_compute_value enabled",
    operationId: "recompute-all-goal-values",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
      }),
    },
    responses: {
      "200": {
        description: "Recomputation complete",
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    try {
      const service = new GoalValueComputationService(c.env.DB, (c.env as any).ANALYTICS_DB);
      await service.recomputeAllGoalValues(orgId);

      return success(c, { recomputed: true });
    } catch (err) {
      structuredLog('ERROR', 'Failed to recompute all goal values', { endpoint: 'POST /v1/goals/recompute-all', error: err instanceof Error ? err.message : String(err) });
      return error(c, "COMPUTATION_FAILED", err instanceof Error ? err.message : "Failed to recompute", 500);
    }
  }
}

/**
 * GET /v1/goals/templates
 * Get goal templates for a business type
 */
export class GetGoalTemplates extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Get goal templates",
    description: "Returns pre-configured goal templates for a business type",
    operationId: "get-goal-templates",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        business_type: z.enum(["ecommerce", "saas", "lead_gen", "content"]).describe("Business type"),
      }),
    },
    responses: {
      "200": {
        description: "Goal templates",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.any()),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const businessType = c.req.query("business_type");

    if (!businessType) {
      return error(c, "MISSING_BUSINESS_TYPE", "Business type required", 400);
    }

    try {
      const result = await c.env.DB.prepare(`
        SELECT * FROM goal_templates
        WHERE business_type = ?
        ORDER BY display_order ASC
      `).bind(businessType).all();

      return success(c, result.results || []);
    } catch (err) {
      structuredLog('ERROR', 'Failed to get goal templates', { endpoint: 'GET /v1/goals/templates', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Failed to get templates", 500);
    }
  }
}

/**
 * POST /v1/goals/from-templates
 * Create goals from selected templates
 */
export class CreateGoalsFromTemplates extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Create goals from templates",
    description: "Creates goals based on selected template IDs",
    operationId: "create-goals-from-templates",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              template_ids: z.array(z.string()).min(1).describe("Template IDs to create goals from"),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Goals created",
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const body = await c.req.json();

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    const { template_ids } = body;

    try {
      const service = new GoalValueComputationService(c.env.DB);
      await service.createGoalsFromTemplates(orgId, template_ids);

      return success(c, { created: template_ids.length });
    } catch (err) {
      structuredLog('ERROR', 'Failed to create goals from templates', { endpoint: 'POST /v1/goals/from-templates', error: err instanceof Error ? err.message : String(err) });
      return error(c, "CREATION_FAILED", err instanceof Error ? err.message : "Failed to create goals", 500);
    }
  }
}

/**
 * GET /v1/goals/:id/conversion-stats
 * Get conversion statistics between this goal and downstream goals
 */
export class GetGoalConversionStats extends OpenAPIRoute {
  schema = {
    tags: ["Goals"],
    summary: "Get goal conversion stats",
    description: "Returns conversion rates from this goal to downstream goals",
    operationId: "get-goal-conversion-stats",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string().describe("Goal ID"),
      }),
      query: z.object({
        org_id: z.string().optional().describe("Organization ID"),
        days: z.coerce.number().int().min(7).max(365).optional().default(90),
      }),
    },
    responses: {
      "200": {
        description: "Conversion statistics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                goal_id: z.string(),
                relationships: z.array(z.object({
                  downstream_goal_id: z.string(),
                  downstream_goal_name: z.string(),
                  conversion_rate: z.number(),
                  converted_count: z.number(),
                  upstream_count: z.number(),
                  avg_time_to_convert_hours: z.number(),
                })),
              }),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.req.query("org_id") || c.get("org_id");
    const { id } = c.req.param() as { id: string };
    const days = parseInt(c.req.query("days") || "90");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization specified", 400);
    }

    try {
      // Get downstream relationships
      const relationships = await c.env.DB.prepare(`
        SELECT gr.*, cg.name as downstream_name
        FROM goal_relationships gr
        JOIN conversion_goals cg ON gr.downstream_goal_id = cg.id
        WHERE gr.organization_id = ? AND gr.upstream_goal_id = ?
      `).bind(orgId, id).all<any>();

      const service = new GoalValueComputationService(c.env.DB, (c.env as any).ANALYTICS_DB);

      const stats = await Promise.all(
        (relationships.results || []).map(async (rel: any) => {
          const convStats = await service.computeConversionStats(
            orgId,
            id,
            rel.downstream_goal_id,
            days
          );

          return {
            downstream_goal_id: rel.downstream_goal_id,
            downstream_goal_name: rel.downstream_name,
            conversion_rate: convStats.conversion_rate,
            converted_count: convStats.converted_count,
            upstream_count: convStats.upstream_count,
            avg_time_to_convert_hours: convStats.avg_time_to_convert_hours,
          };
        })
      );

      return success(c, {
        goal_id: id,
        relationships: stats,
      });
    } catch (err) {
      structuredLog('ERROR', 'Failed to get conversion stats', { endpoint: 'GET /v1/goals/:id/conversion-stats', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", err instanceof Error ? err.message : "Failed to get stats", 500);
    }
  }
}
