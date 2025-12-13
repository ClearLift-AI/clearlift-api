import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";

// ============== Schema Definitions ==============

const TriggerConfigSchema = z.object({
  event_type: z.string().optional(),       // 'purchase', 'signup', 'demo_request'
  page_pattern: z.string().optional(),     // '/thank-you', '/confirmation/*'
  revenue_min: z.number().optional(),      // Minimum $ value
  custom_event: z.string().optional(),     // Custom event name from clearlift.track()
}).strict();

const ConversionGoalSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  type: z.enum(['conversion', 'micro_conversion', 'engagement']).default('conversion'),
  trigger_config: TriggerConfigSchema,
  default_value_cents: z.number().int().min(0).default(0),
  is_primary: z.boolean().default(false),
  include_in_path: z.boolean().default(true),
  priority: z.number().int().default(0),
});

const FilterRuleSchema = z.object({
  field: z.string(),       // 'page_path', 'utm_source', 'event_type'
  operator: z.enum([
    'equals', 'not_equals',
    'contains', 'not_contains',
    'starts_with', 'ends_with',
    'in', 'not_in',
    'exists', 'not_exists',
    'is_empty', 'is_not_empty'
  ]),
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
});

const EventFilterSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  filter_type: z.enum(['include', 'exclude']).default('exclude'),
  rules: z.array(FilterRuleSchema).min(1),
  is_active: z.boolean().default(true),
});

// ============== Conversion Goals Endpoints ==============

/**
 * GET /v1/goals - List conversion goals
 */
export class ListConversionGoals extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "List conversion goals for an organization",
    operationId: "list-conversion-goals",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "List of conversion goals",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(ConversionGoalSchema.extend({
                id: z.string(),
                created_at: z.string(),
                updated_at: z.string(),
              }))
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
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Verify access
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const goals = await c.env.DB.prepare(`
      SELECT id, name, type, trigger_config, default_value_cents,
             is_primary, include_in_path, priority, created_at, updated_at
      FROM conversion_goals
      WHERE organization_id = ?
      ORDER BY priority ASC, created_at DESC
    `).bind(orgId).all();

    // Parse JSON fields
    const parsedGoals = (goals.results || []).map(g => ({
      ...g,
      trigger_config: JSON.parse(g.trigger_config as string || '{}'),
      is_primary: Boolean(g.is_primary),
      include_in_path: Boolean(g.include_in_path),
    }));

    return success(c, parsedGoals);
  }
}

/**
 * POST /v1/goals - Create a conversion goal
 */
export class CreateConversionGoal extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Create a new conversion goal",
    operationId: "create-conversion-goal",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: ConversionGoalSchema.omit({ id: true })
          }
        }
      }
    },
    responses: {
      "201": {
        description: "Conversion goal created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: ConversionGoalSchema.extend({
                id: z.string(),
                created_at: z.string(),
                updated_at: z.string(),
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
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Verify access
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const body = data.body;

    // Generate ID
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO conversion_goals (
        id, organization_id, name, type, trigger_config,
        default_value_cents, is_primary, include_in_path, priority,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      orgId,
      body.name,
      body.type,
      JSON.stringify(body.trigger_config),
      body.default_value_cents,
      body.is_primary ? 1 : 0,
      body.include_in_path ? 1 : 0,
      body.priority,
      now,
      now
    ).run();

    return success(c, {
      id,
      ...body,
      created_at: now,
      updated_at: now,
    }, undefined, 201);
  }
}

/**
 * PUT /v1/goals/:id - Update a conversion goal
 */
export class UpdateConversionGoal extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Update a conversion goal",
    operationId: "update-conversion-goal",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string()
      }),
      body: {
        content: {
          "application/json": {
            schema: ConversionGoalSchema.partial().omit({ id: true })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Conversion goal updated"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const goalId = data.params.id;
    const body = data.body;

    // Verify goal belongs to org
    const existing = await c.env.DB.prepare(`
      SELECT id FROM conversion_goals
      WHERE id = ? AND organization_id = ?
    `).bind(goalId, orgId).first();

    if (!existing) {
      return error(c, "NOT_FOUND", "Goal not found", 404);
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.type !== undefined) {
      updates.push('type = ?');
      values.push(body.type);
    }
    if (body.trigger_config !== undefined) {
      updates.push('trigger_config = ?');
      values.push(JSON.stringify(body.trigger_config));
    }
    if (body.default_value_cents !== undefined) {
      updates.push('default_value_cents = ?');
      values.push(body.default_value_cents);
    }
    if (body.is_primary !== undefined) {
      updates.push('is_primary = ?');
      values.push(body.is_primary ? 1 : 0);
    }
    if (body.include_in_path !== undefined) {
      updates.push('include_in_path = ?');
      values.push(body.include_in_path ? 1 : 0);
    }
    if (body.priority !== undefined) {
      updates.push('priority = ?');
      values.push(body.priority);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(goalId);

      await c.env.DB.prepare(`
        UPDATE conversion_goals SET ${updates.join(', ')} WHERE id = ?
      `).bind(...values).run();
    }

    return success(c, { updated: true });
  }
}

/**
 * DELETE /v1/goals/:id - Delete a conversion goal
 */
export class DeleteConversionGoal extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Delete a conversion goal",
    operationId: "delete-conversion-goal",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Conversion goal deleted"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const goalId = data.params.id;

    const result = await c.env.DB.prepare(`
      DELETE FROM conversion_goals WHERE id = ? AND organization_id = ?
    `).bind(goalId, orgId).run();

    if (!result.meta?.changes) {
      return error(c, "NOT_FOUND", "Goal not found", 404);
    }

    return success(c, { deleted: true });
  }
}

// ============== Event Filters Endpoints ==============

/**
 * GET /v1/event-filters - List event filters
 */
export class ListEventFilters extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "List event filters for an organization",
    operationId: "list-event-filters",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "List of event filters",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(EventFilterSchema.extend({
                id: z.string(),
                created_at: z.string(),
                updated_at: z.string(),
              }))
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
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Verify access
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const filters = await c.env.DB.prepare(`
      SELECT id, name, filter_type, rules, is_active, created_at, updated_at
      FROM event_filters
      WHERE organization_id = ?
      ORDER BY created_at DESC
    `).bind(orgId).all();

    // Parse JSON fields
    const parsedFilters = (filters.results || []).map(f => ({
      ...f,
      rules: JSON.parse(f.rules as string || '[]'),
      is_active: Boolean(f.is_active),
    }));

    return success(c, parsedFilters);
  }
}

/**
 * POST /v1/event-filters - Create an event filter
 */
export class CreateEventFilter extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Create a new event filter",
    operationId: "create-event-filter",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: EventFilterSchema.omit({ id: true })
          }
        }
      }
    },
    responses: {
      "201": {
        description: "Event filter created"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Verify access
    const memberCheck = await c.env.DB.prepare(`
      SELECT 1 FROM organization_members
      WHERE organization_id = ? AND user_id = ?
    `).bind(orgId, session.user_id).first();

    if (!memberCheck) {
      return error(c, "FORBIDDEN", "Access denied to this organization", 403);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const body = data.body;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await c.env.DB.prepare(`
      INSERT INTO event_filters (
        id, organization_id, name, filter_type, rules, is_active,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      orgId,
      body.name,
      body.filter_type,
      JSON.stringify(body.rules),
      body.is_active ? 1 : 0,
      now,
      now
    ).run();

    return success(c, {
      id,
      ...body,
      created_at: now,
      updated_at: now,
    }, undefined, 201);
  }
}

/**
 * PUT /v1/event-filters/:id - Update an event filter
 */
export class UpdateEventFilter extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Update an event filter",
    operationId: "update-event-filter",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string()
      }),
      body: {
        content: {
          "application/json": {
            schema: EventFilterSchema.partial().omit({ id: true })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Event filter updated"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const filterId = data.params.id;
    const body = data.body;

    // Verify filter belongs to org
    const existing = await c.env.DB.prepare(`
      SELECT id FROM event_filters
      WHERE id = ? AND organization_id = ?
    `).bind(filterId, orgId).first();

    if (!existing) {
      return error(c, "NOT_FOUND", "Filter not found", 404);
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.filter_type !== undefined) {
      updates.push('filter_type = ?');
      values.push(body.filter_type);
    }
    if (body.rules !== undefined) {
      updates.push('rules = ?');
      values.push(JSON.stringify(body.rules));
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(filterId);

      await c.env.DB.prepare(`
        UPDATE event_filters SET ${updates.join(', ')} WHERE id = ?
      `).bind(...values).run();
    }

    return success(c, { updated: true });
  }
}

/**
 * DELETE /v1/event-filters/:id - Delete an event filter
 */
export class DeleteEventFilter extends OpenAPIRoute {
  public schema = {
    tags: ["Goals"],
    summary: "Delete an event filter",
    operationId: "delete-event-filter",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Event filter deleted"
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    const data = await this.getValidatedData<typeof this.schema>();
    const filterId = data.params.id;

    const result = await c.env.DB.prepare(`
      DELETE FROM event_filters WHERE id = ? AND organization_id = ?
    `).bind(filterId, orgId).run();

    if (!result.meta?.changes) {
      return error(c, "NOT_FOUND", "Filter not found", 404);
    }

    return success(c, { deleted: true });
  }
}
