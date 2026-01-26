/**
 * Goal Groups Endpoints
 *
 * API endpoints for managing goal groups (multi-conversion support).
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { GoalGroupService } from "../../../services/conversion-value";

// =============================================================================
// List Goal Groups
// =============================================================================

export class ListGoalGroups extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "List goal groups for an organization",
    operationId: "goal-groups-list",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "List of goal groups",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                id: z.string(),
                name: z.string(),
                description: z.string().nullable(),
                group_type: z.string(),
                is_default_attribution: z.boolean(),
                member_count: z.number(),
              })),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");

    const service = new GoalGroupService(c.env.DB);
    const groups = await service.getGroups(orgId!);

    return success(c, groups.map(g => ({
      ...g,
      is_default_attribution: !!g.is_default_attribution,
    })));
  }
}

// =============================================================================
// Create Goal Group
// =============================================================================

export class CreateGoalGroup extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Create a goal group",
    operationId: "goal-groups-create",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().describe("Group name"),
              description: z.string().optional(),
              group_type: z.enum(["conversion", "engagement", "funnel", "custom"]).default("conversion"),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Group created",
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

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");
    const body = await c.req.json();
    const { name, description, group_type = "conversion" } = body;

    const service = new GoalGroupService(c.env.DB);
    const groupId = await service.createGroup(orgId!, name, group_type, description);

    return success(c, { id: groupId });
  }
}

// =============================================================================
// Get Goal Group Members
// =============================================================================

export class GetGoalGroupMembers extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Get members of a goal group",
    operationId: "goal-groups-members-get",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string(),
      }),
      query: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Group members",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(z.object({
                goal_id: z.string(),
                goal_name: z.string(),
                weight: z.number(),
              })),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const { id } = c.req.param() as { id: string };

    const service = new GoalGroupService(c.env.DB);
    const members = await service.getGroupMembers(id);

    return success(c, members);
  }
}

// =============================================================================
// Update Goal Group Members
// =============================================================================

export class UpdateGoalGroupMembers extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Update members and weights of a goal group",
    operationId: "goal-groups-members-update",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string(),
      }),
      query: z.object({
        org_id: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              members: z.array(z.object({
                goal_id: z.string(),
                weight: z.number().default(1.0),
              })),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Members updated",
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
    const { id } = c.req.param() as { id: string };
    const body = await c.req.json();
    const { members } = body;

    const service = new GoalGroupService(c.env.DB);
    await service.updateGroupMembers(
      id,
      members.map((m: any) => ({ goalId: m.goal_id, weight: m.weight }))
    );

    return success(c, { updated: true });
  }
}

// =============================================================================
// Set Default Attribution Group
// =============================================================================

export class SetDefaultAttributionGroup extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Set a goal group as the default for attribution",
    operationId: "goal-groups-set-default",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string(),
      }),
      query: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Default set",
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
    const { id } = c.req.param() as { id: string };
    const orgId = c.req.query("org_id");

    const service = new GoalGroupService(c.env.DB);
    await service.setDefaultAttributionGroup(orgId!, id);

    return success(c, { updated: true });
  }
}

// =============================================================================
// Delete Goal Group
// =============================================================================

export class DeleteGoalGroup extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Delete a goal group",
    operationId: "goal-groups-delete",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string(),
      }),
      query: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Group deleted",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                deleted: z.boolean(),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const { id } = c.req.param() as { id: string };
    const orgId = c.req.query("org_id");

    const result = await c.env.DB.prepare(
      `DELETE FROM goal_groups WHERE id = ? AND organization_id = ?`
    )
      .bind(id, orgId)
      .run();

    if (!result.meta.changes) {
      return error(c, "NOT_FOUND", "Goal group not found", 404);
    }

    return success(c, { deleted: true });
  }
}
