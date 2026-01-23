import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { success, error } from "../../utils/response";
import { calculateGoalValue, validateGoalValueConfig } from "../../services/goal-value";

// ============== Schema Definitions ==============

const TriggerConfigSchema = z.object({
  event_type: z.string().optional(),       // 'purchase', 'signup', 'demo_request'
  page_pattern: z.string().optional(),     // '/thank-you', '/confirmation/*'
  revenue_min: z.number().optional(),      // Minimum $ value
  custom_event: z.string().optional(),     // Custom event name from clearlift.track()
}).passthrough();

// Enhanced event filters schema for tag_event goals
const EnhancedEventFiltersSchema = z.object({
  event_type: z.string().optional(),      // 'form_submit', 'purchase', 'click'
  goal_id: z.string().optional(),         // Specific goal_id from tag
  url_pattern: z.string().optional(),     // Regex pattern to match URL
}).passthrough();

const ConversionGoalSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  type: z.enum(['conversion', 'micro_conversion', 'engagement']).default('conversion'),
  trigger_config: TriggerConfigSchema.optional().default({}),
  default_value_cents: z.number().int().min(0).default(0),
  is_primary: z.boolean().default(false),
  include_in_path: z.boolean().default(true),
  priority: z.number().int().default(0),
  // Enhanced value configuration
  value_type: z.enum(['from_source', 'fixed', 'calculated', 'none']).optional(),
  fixed_value_cents: z.number().int().min(0).optional(),
  avg_deal_value_cents: z.number().int().min(0).optional(),
  close_rate_percent: z.number().int().min(0).max(100).optional(),
  // Enhanced multi-source goal fields
  slug: z.string().optional(),
  description: z.string().optional(),
  goal_type: z.enum(['revenue_source', 'tag_event', 'manual']).optional(),
  revenue_sources: z.array(z.string()).optional(),
  event_filters: EnhancedEventFiltersSchema.optional(),
  display_order: z.number().int().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  is_active: z.boolean().optional(),
  // Flow Builder fields
  connector: z.string().optional(),              // 'clearlift_tag', 'stripe', 'shopify', etc.
  connector_event_type: z.string().optional(),   // 'page_view', 'payment_success', etc.
  is_conversion: z.union([z.boolean(), z.number()]).optional(), // Can be marked as conversion point
  position_col: z.number().int().min(0).optional(), // Graph X position
  position_row: z.number().int().min(0).optional(), // Graph Y position (funnel order)
}).passthrough(); // Allow extra fields that may be sent by frontend

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
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "No organization selected", 403);
    }

    // Note: Access already verified by requireOrg middleware (handles admin bypass)

    const goals = await c.env.DB.prepare(`
      SELECT id, name, type, trigger_config, default_value_cents,
             is_primary, include_in_path, priority, created_at, updated_at,
             slug, description, goal_type, revenue_sources, event_filters_v2,
             value_type, fixed_value_cents, display_order, color, icon, is_active,
             avg_deal_value_cents, close_rate_percent,
             connector, connector_event_type, is_conversion, position_col, position_row
      FROM conversion_goals
      WHERE organization_id = ?
      ORDER BY COALESCE(position_row, display_order, priority) ASC, created_at DESC
    `).bind(orgId).all();

    // Parse JSON fields and include enhanced properties
    const parsedGoals = (goals.results || []).map(g => {
      // Calculate the effective value based on value_type
      const calculatedResult = calculateGoalValue({
        id: g.id as string,
        name: g.name as string,
        value_type: (g.value_type || 'from_source') as 'from_source' | 'fixed' | 'calculated' | 'none',
        fixed_value_cents: g.fixed_value_cents as number | undefined,
        avg_deal_value_cents: g.avg_deal_value_cents as number | undefined,
        close_rate_percent: g.close_rate_percent as number | undefined,
        default_value_cents: g.default_value_cents as number | undefined,
      });

      return {
        ...g,
        trigger_config: JSON.parse(g.trigger_config as string || '{}'),
        is_primary: Boolean(g.is_primary),
        include_in_path: Boolean(g.include_in_path),
        is_active: g.is_active !== 0,
        // Enhanced fields
        revenue_sources: g.revenue_sources ? JSON.parse(g.revenue_sources as string) : undefined,
        event_filters: g.event_filters_v2 ? JSON.parse(g.event_filters_v2 as string) : undefined,
        // Calculated value based on value_type
        calculated_value_cents: calculatedResult.value_cents,
        value_formula: calculatedResult.formula_used,
        // Flow Builder fields
        connector: g.connector || null,
        connector_event_type: g.connector_event_type || null,
        is_conversion: Boolean(g.is_conversion),
        position_col: g.position_col ?? 0,
        position_row: g.position_row ?? null,
      };
    });

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
      query: z.object({
        org_id: z.string().optional(),
      }),
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

    // Note: Access already verified by requireOrg middleware (handles admin bypass)

    const data = await this.getValidatedData<typeof this.schema>();
    const body = data.body;

    // Validate value configuration if using calculated type
    if (body.value_type === 'calculated') {
      const validationErrors = validateGoalValueConfig(body);
      if (validationErrors.length > 0) {
        return error(c, "VALIDATION_ERROR", validationErrors.join(', '), 400);
      }
    }

    // Generate ID
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Map type to category for funnel hierarchy
    // 'conversion' → 'macro_conversion', others stay the same
    const category = body.type === 'conversion' ? 'macro_conversion' : body.type;

    await c.env.DB.prepare(`
      INSERT INTO conversion_goals (
        id, organization_id, name, type, category, trigger_config,
        default_value_cents, is_primary, include_in_path, priority,
        value_type, fixed_value_cents, avg_deal_value_cents, close_rate_percent,
        slug, description, goal_type, revenue_sources, event_filters_v2,
        display_order, color, icon, is_active,
        connector, connector_event_type, is_conversion, position_col, position_row,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      orgId,
      body.name,
      body.type,
      category,
      JSON.stringify(body.trigger_config || {}),
      body.default_value_cents,
      body.is_primary ? 1 : 0,
      body.include_in_path ? 1 : 0,
      body.priority ?? 0,
      body.value_type || 'from_source',
      body.fixed_value_cents ?? null,
      body.avg_deal_value_cents ?? null,
      body.close_rate_percent ?? null,
      body.slug ?? null,
      body.description ?? null,
      body.goal_type ?? null,
      body.revenue_sources ? JSON.stringify(body.revenue_sources) : null,
      body.event_filters ? JSON.stringify(body.event_filters) : null,
      body.display_order ?? null,
      body.color ?? null,
      body.icon ?? null,
      body.is_active !== false ? 1 : 0,
      body.connector ?? null,
      body.connector_event_type ?? null,
      body.is_conversion ? 1 : 0,
      body.position_col ?? 0,
      body.position_row ?? null,
      now,
      now
    ).run();

    // Calculate the effective value for the response
    const calculatedResult = calculateGoalValue({
      id,
      name: body.name,
      value_type: body.value_type,
      fixed_value_cents: body.fixed_value_cents,
      avg_deal_value_cents: body.avg_deal_value_cents,
      close_rate_percent: body.close_rate_percent,
      default_value_cents: body.default_value_cents,
    });

    return success(c, {
      id,
      ...body,
      calculated_value_cents: calculatedResult.value_cents,
      value_formula: calculatedResult.formula_used,
      // Normalize Flow Builder fields in response
      connector: body.connector || null,
      connector_event_type: body.connector_event_type || null,
      is_conversion: Boolean(body.is_conversion),
      position_col: body.position_col ?? 0,
      position_row: body.position_row ?? null,
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
      query: z.object({
        org_id: z.string().optional(),
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
      // Also update category for funnel hierarchy
      const category = body.type === 'conversion' ? 'macro_conversion' : body.type;
      updates.push('category = ?');
      values.push(category);
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
    // Enhanced value configuration fields
    if (body.value_type !== undefined) {
      updates.push('value_type = ?');
      values.push(body.value_type);
    }
    if (body.fixed_value_cents !== undefined) {
      updates.push('fixed_value_cents = ?');
      values.push(body.fixed_value_cents);
    }
    if (body.avg_deal_value_cents !== undefined) {
      updates.push('avg_deal_value_cents = ?');
      values.push(body.avg_deal_value_cents);
    }
    if (body.close_rate_percent !== undefined) {
      updates.push('close_rate_percent = ?');
      values.push(body.close_rate_percent);
    }

    // Validate value configuration
    if (body.value_type === 'calculated') {
      const validationErrors = validateGoalValueConfig(body);
      if (validationErrors.length > 0) {
        return error(c, "VALIDATION_ERROR", validationErrors.join(', '), 400);
      }
    }

    // Enhanced goal fields
    if (body.slug !== undefined) {
      updates.push('slug = ?');
      values.push(body.slug);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.goal_type !== undefined) {
      updates.push('goal_type = ?');
      values.push(body.goal_type);
    }
    if (body.revenue_sources !== undefined) {
      updates.push('revenue_sources = ?');
      values.push(JSON.stringify(body.revenue_sources));
    }
    if (body.event_filters !== undefined) {
      updates.push('event_filters_v2 = ?');
      values.push(JSON.stringify(body.event_filters));
    }
    if (body.display_order !== undefined) {
      updates.push('display_order = ?');
      values.push(body.display_order);
    }
    if (body.color !== undefined) {
      updates.push('color = ?');
      values.push(body.color);
    }
    if (body.icon !== undefined) {
      updates.push('icon = ?');
      values.push(body.icon);
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }

    // Flow Builder fields
    if (body.connector !== undefined) {
      updates.push('connector = ?');
      values.push(body.connector);
    }
    if (body.connector_event_type !== undefined) {
      updates.push('connector_event_type = ?');
      values.push(body.connector_event_type);
    }
    if (body.is_conversion !== undefined) {
      updates.push('is_conversion = ?');
      values.push(body.is_conversion ? 1 : 0);
    }
    if (body.position_col !== undefined) {
      updates.push('position_col = ?');
      values.push(body.position_col);
    }
    if (body.position_row !== undefined) {
      updates.push('position_row = ?');
      values.push(body.position_row);
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
      }),
      query: z.object({
        org_id: z.string().optional(),
      }),
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

    // Note: Access already verified by requireOrg middleware (handles admin bypass)

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

    // Note: Access already verified by requireOrg middleware (handles admin bypass)

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
