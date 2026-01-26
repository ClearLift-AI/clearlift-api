/**
 * Goal Graph Endpoints
 *
 * API endpoints for funnel graph operations:
 * - Get full graph for Flow Builder visualization
 * - Create/manage branches and relationships
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { FunnelGraphService } from "../../../services/funnel-graph";

// =============================================================================
// Get Full Funnel Graph
// =============================================================================

export class GetFunnelGraph extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Get the complete funnel graph for visualization",
    operationId: "goals-graph-get",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Funnel graph",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                nodes: z.array(z.object({
                  id: z.string(),
                  name: z.string(),
                  type: z.enum(["goal", "branch_split", "branch_join"]),
                  goalType: z.string().optional(),
                  category: z.string().optional(),
                  connector: z.string().optional(),
                  isConversion: z.boolean().optional(),
                  flowTag: z.string().optional(),
                  isExclusive: z.boolean().optional(),
                  position: z.object({
                    col: z.number(),
                    row: z.number(),
                  }).optional(),
                })),
                edges: z.array(z.object({
                  id: z.string(),
                  source: z.string(),
                  target: z.string(),
                  relationshipType: z.enum(["funnel", "correlated"]),
                  operator: z.enum(["OR", "AND"]),
                  flowTag: z.string().optional(),
                  isExclusive: z.boolean().optional(),
                })),
                entryPoints: z.array(z.string()),
                exitPoints: z.array(z.string()),
                flows: z.array(z.string()),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");

    const service = new FunnelGraphService(c.env.DB);
    const graph = await service.buildFunnelGraph(orgId!);

    return success(c, graph);
  }
}

// =============================================================================
// Create Goal Relationship with OR/AND
// =============================================================================

export class CreateGoalRelationshipV2 extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Create a goal relationship with OR/AND operator support",
    operationId: "goals-relationship-create-v2",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              upstream_goal_id: z.string(),
              downstream_goal_id: z.string(),
              relationship_type: z.enum(["funnel", "correlated"]).default("funnel"),
              operator: z.enum(["OR", "AND"]).default("OR"),
              flow_tag: z.string().optional(),
              is_exclusive: z.boolean().default(false),
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
      "400": {
        description: "Invalid relationship or cycle detected",
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");
    const body = await c.req.json();
    const {
      upstream_goal_id,
      downstream_goal_id,
      relationship_type = "funnel",
      operator = "OR",
      flow_tag,
      is_exclusive = false,
    } = body;

    // Validate goals exist
    const upstreamGoal = await c.env.DB.prepare(
      `SELECT id FROM conversion_goals WHERE id = ? AND organization_id = ?`
    )
      .bind(upstream_goal_id, orgId)
      .first();

    const downstreamGoal = await c.env.DB.prepare(
      `SELECT id FROM conversion_goals WHERE id = ? AND organization_id = ?`
    )
      .bind(downstream_goal_id, orgId)
      .first();

    if (!upstreamGoal || !downstreamGoal) {
      return error(c, "GOAL_NOT_FOUND", "One or both goals not found", 400);
    }

    // Check for existing relationship
    const existing = await c.env.DB.prepare(
      `SELECT id FROM goal_relationships
       WHERE organization_id = ? AND upstream_goal_id = ? AND downstream_goal_id = ?`
    )
      .bind(orgId, upstream_goal_id, downstream_goal_id)
      .first();

    if (existing) {
      // Update existing
      await c.env.DB.prepare(
        `UPDATE goal_relationships
         SET relationship_type = ?, relationship_operator = ?, flow_tag = ?, is_exclusive = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
        .bind(relationship_type, operator, flow_tag || null, is_exclusive ? 1 : 0, existing.id)
        .run();

      return success(c, { id: existing.id });
    }

    // Create new relationship
    const relId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO goal_relationships
       (id, organization_id, upstream_goal_id, downstream_goal_id, relationship_type, relationship_operator, flow_tag, is_exclusive, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(relId, orgId, upstream_goal_id, downstream_goal_id, relationship_type, operator, flow_tag || null, is_exclusive ? 1 : 0)
      .run();

    return success(c, { id: relId });
  }
}

// =============================================================================
// Create Branch Point
// =============================================================================

export class CreateGoalBranch extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Create a branch point (split or join) in the funnel",
    operationId: "goals-branch-create",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              branch_goal_id: z.string().describe("The goal where branching occurs"),
              child_goal_ids: z.array(z.string()).describe("Goals that branch from/to"),
              flow_tags: z.array(z.string()).describe("Flow tags for each branch"),
              branch_type: z.enum(["split", "join"]).default("split"),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Branch created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                branch_id: z.string(),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");
    const body = await c.req.json();
    const { branch_goal_id, child_goal_ids, flow_tags, branch_type = "split" } = body;

    const service = new FunnelGraphService(c.env.DB);
    const branchId = await service.createBranch(
      orgId!,
      branch_goal_id,
      child_goal_ids,
      flow_tags,
      branch_type
    );

    return success(c, { branch_id: branchId });
  }
}

// =============================================================================
// Create Merge Point
// =============================================================================

export class CreateGoalMerge extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Create a merge point where multiple paths converge",
    operationId: "goals-merge-create",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              merge_goal_id: z.string().describe("The goal where paths merge"),
              parent_goal_ids: z.array(z.string()).describe("Parent goals that lead here"),
              operator: z.enum(["OR", "AND"]).default("OR").describe("OR: any parent, AND: all parents required"),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Merge created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                updated: z.boolean(),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");
    const body = await c.req.json();
    const { merge_goal_id, parent_goal_ids, operator = "OR" } = body;

    const service = new FunnelGraphService(c.env.DB);
    await service.createMerge(orgId!, merge_goal_id, parent_goal_ids, operator);

    return success(c, { updated: true });
  }
}

// =============================================================================
// Get Valid Paths
// =============================================================================

export class GetValidPaths extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Get valid paths through the funnel to a goal",
    operationId: "goals-paths-get",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
        goal_id: z.string(),
        from_goal_ids: z.string().optional().describe("Comma-separated start goal IDs (default: all entry points)"),
      }),
    },
    responses: {
      "200": {
        description: "Valid paths",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                goalIds: z.array(z.string()),
                flowTag: z.string().optional(),
                probability: z.number().optional(),
              })),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");
    const goalId = c.req.query("goal_id");
    const fromGoalIdsParam = c.req.query("from_goal_ids");

    const service = new FunnelGraphService(c.env.DB);

    let fromGoalIds: string[];
    if (fromGoalIdsParam) {
      fromGoalIds = fromGoalIdsParam.split(",").map(s => s.trim());
    } else {
      // Use all entry points
      const graph = await service.buildFunnelGraph(orgId!);
      fromGoalIds = graph.entryPoints;
    }

    const paths = await service.getValidPaths(orgId!, fromGoalIds, goalId!);

    return success(c, paths);
  }
}
