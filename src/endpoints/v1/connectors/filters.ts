/**
 * Filter Management Endpoints
 *
 * Manage filter rules for platform connectors with support for
 * arbitrary metadata filtering
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { StripeQueryBuilder } from "../../../services/filters/stripeQueryBuilder";
import { StripeAdapter } from "../../../adapters/platforms/stripe";

// Zod schemas for validation
const FilterConditionSchema = z.object({
  type: z.enum(['standard', 'metadata']),
  field: z.enum([
    'charge_id', 'product_id', 'price_id', 'amount',
    'currency', 'status', 'customer_id', 'description', 'created_at'
  ]).optional(),
  metadata_source: z.enum(['charge', 'product', 'price', 'customer']).optional(),
  metadata_key: z.string().optional(),
  operator: z.enum([
    'equals', 'not_equals', 'contains', 'not_contains',
    'starts_with', 'ends_with', 'gt', 'gte', 'lt', 'lte',
    'in', 'not_in', 'exists', 'not_exists', 'regex'
  ]),
  value: z.any()
});

const FilterRuleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  rule_type: z.enum(['include', 'exclude']).default('include'),
  operator: z.enum(['AND', 'OR']).default('AND'),
  conditions: z.array(FilterConditionSchema).min(1).max(20),
  is_active: z.boolean().default(true)
});

/**
 * POST /v1/connectors/{connection_id}/filters
 * Create a new filter rule
 */
export class CreateFilterRule extends OpenAPIRoute {
  schema = {
    tags: ["Filters"],
    summary: "Create filter rule",
    description: "Create a new filter rule for a platform connection",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      body: contentJson(FilterRuleSchema)
    },
    responses: {
      "201": {
        description: "Filter created successfully"
      },
      "400": {
        description: "Invalid filter configuration"
      },
      "404": {
        description: "Connection not found"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const { params, body } = await this.getValidatedData<typeof this.schema>();
    const connectionId = params.connection_id;

    // Verify connection exists and user has access
    const connection = await c.env.DB.prepare(`
      SELECT pc.*, om.role
      FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found or access denied", 404);
    }

    // Validate filter based on platform type
    const queryBuilder = new StripeQueryBuilder();
    const validation = queryBuilder.validateFilter({
      ...body,
      conditions: body.conditions
    });

    if (!validation.valid) {
      return error(c, "VALIDATION_ERROR", validation.errors?.join(', ') || "Invalid filter", 400);
    }

    // Create filter rule
    const filterId = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO connector_filter_rules (
        id, connection_id, name, description, rule_type,
        operator, conditions, is_active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      filterId,
      connectionId,
      body.name,
      body.description || null,
      body.rule_type || 'include',
      body.operator,
      JSON.stringify(body.conditions),
      body.is_active ? 1 : 0,
      session.user_id
    ).run();

    // Update filter count on connection
    await c.env.DB.prepare(`
      UPDATE platform_connections
      SET filter_rules_count = (
        SELECT COUNT(*) FROM connector_filter_rules
        WHERE connection_id = ? AND is_active = 1
      )
      WHERE id = ?
    `).bind(connectionId, connectionId).run();

    return success(c, {
      filter_id: filterId,
      validation_warnings: validation.warnings
    }, 201);
  }
}

/**
 * GET /v1/connectors/{connection_id}/filters
 * List all filter rules for a connection
 */
export class ListFilterRules extends OpenAPIRoute {
  schema = {
    tags: ["Filters"],
    summary: "List filter rules",
    description: "Get all filter rules for a platform connection",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      query: z.object({
        include_inactive: z.coerce.boolean().optional()
      })
    },
    responses: {
      "200": {
        description: "List of filter rules"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const { params, query } = await this.getValidatedData<typeof this.schema>();
    const connectionId = params.connection_id;

    // Verify access
    const hasAccess = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Get filter rules
    let sql = `
      SELECT * FROM connector_filter_rules
      WHERE connection_id = ?
    `;

    if (!query.include_inactive) {
      sql += ` AND is_active = 1`;
    }

    sql += ` ORDER BY created_at DESC`;

    const result = await c.env.DB.prepare(sql).bind(connectionId).all();

    const filters = (result.results || []).map(rule => ({
      ...rule,
      conditions: JSON.parse(rule.conditions as string)
    }));

    return success(c, { filters });
  }
}

/**
 * PUT /v1/connectors/{connection_id}/filters/{filter_id}
 * Update a filter rule
 */
export class UpdateFilterRule extends OpenAPIRoute {
  schema = {
    tags: ["Filters"],
    summary: "Update filter rule",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string(),
        filter_id: z.string()
      }),
      body: contentJson(FilterRuleSchema.partial())
    },
    responses: {
      "200": {
        description: "Filter updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const { params, body } = await this.getValidatedData<typeof this.schema>();
    const { connection_id, filter_id } = params;

    // Verify filter exists and user has access
    const filter = await c.env.DB.prepare(`
      SELECT fr.*, om.role
      FROM connector_filter_rules fr
      INNER JOIN platform_connections pc ON fr.connection_id = pc.id
      INNER JOIN organization_members om ON pc.organization_id = om.organization_id
      WHERE fr.id = ? AND fr.connection_id = ? AND om.user_id = ?
    `).bind(filter_id, connection_id, session.user_id).first();

    if (!filter) {
      return error(c, "NOT_FOUND", "Filter not found or access denied", 404);
    }

    // Validate if conditions changed
    if (body.conditions) {
      const queryBuilder = new StripeQueryBuilder();
      const validation = queryBuilder.validateFilter({
        name: body.name || filter.name,
        operator: body.operator || filter.operator,
        conditions: body.conditions
      });

      if (!validation.valid) {
        return error(c, "VALIDATION_ERROR", validation.errors?.join(', ') || "Invalid filter", 400);
      }
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.rule_type !== undefined) {
      updates.push('rule_type = ?');
      values.push(body.rule_type);
    }
    if (body.operator !== undefined) {
      updates.push('operator = ?');
      values.push(body.operator);
    }
    if (body.conditions !== undefined) {
      updates.push('conditions = ?');
      values.push(JSON.stringify(body.conditions));
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(body.is_active ? 1 : 0);
    }

    updates.push('updated_at = datetime("now")');
    values.push(filter_id, connection_id);

    await c.env.DB.prepare(`
      UPDATE connector_filter_rules
      SET ${updates.join(', ')}
      WHERE id = ? AND connection_id = ?
    `).bind(...values).run();

    // Update filter count
    await c.env.DB.prepare(`
      UPDATE platform_connections
      SET filter_rules_count = (
        SELECT COUNT(*) FROM connector_filter_rules
        WHERE connection_id = ? AND is_active = 1
      )
      WHERE id = ?
    `).bind(connection_id, connection_id).run();

    return success(c, { message: "Filter updated successfully" });
  }
}

/**
 * DELETE /v1/connectors/{connection_id}/filters/{filter_id}
 * Delete a filter rule
 */
export class DeleteFilterRule extends OpenAPIRoute {
  schema = {
    tags: ["Filters"],
    summary: "Delete filter rule",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string(),
        filter_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Filter deleted successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const { params } = await this.getValidatedData<typeof this.schema>();
    const { connection_id, filter_id } = params;

    // Verify filter exists and user has admin/owner role
    const filter = await c.env.DB.prepare(`
      SELECT om.role
      FROM connector_filter_rules fr
      INNER JOIN platform_connections pc ON fr.connection_id = pc.id
      INNER JOIN organization_members om ON pc.organization_id = om.organization_id
      WHERE fr.id = ? AND fr.connection_id = ? AND om.user_id = ?
    `).bind(filter_id, connection_id, session.user_id).first();

    if (!filter) {
      return error(c, "NOT_FOUND", "Filter not found or access denied", 404);
    }

    if (filter.role === 'viewer') {
      return error(c, "FORBIDDEN", "Insufficient permissions", 403);
    }

    // Delete filter
    await c.env.DB.prepare(`
      DELETE FROM connector_filter_rules
      WHERE id = ? AND connection_id = ?
    `).bind(filter_id, connection_id).run();

    // Update filter count
    await c.env.DB.prepare(`
      UPDATE platform_connections
      SET filter_rules_count = (
        SELECT COUNT(*) FROM connector_filter_rules
        WHERE connection_id = ? AND is_active = 1
      )
      WHERE id = ?
    `).bind(connection_id, connection_id).run();

    return success(c, { message: "Filter deleted successfully" });
  }
}

/**
 * POST /v1/connectors/{connection_id}/filters/test
 * Test filter rules with sample data
 */
export class TestFilterRule extends OpenAPIRoute {
  schema = {
    tags: ["Filters"],
    summary: "Test filter rule",
    description: "Test filter rules against recent data",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      body: contentJson(z.object({
        filter_rule: FilterRuleSchema,
        sample_size: z.number().min(1).max(100).default(10)
      }))
    },
    responses: {
      "200": {
        description: "Filter test results"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const { params, body } = await this.getValidatedData<typeof this.schema>();
    const connectionId = params.connection_id;

    // Verify access
    const hasAccess = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Get sample data
    const sampleData = await c.env.DB.prepare(`
      SELECT * FROM stripe_revenue_data
      WHERE connection_id = ?
      ORDER BY stripe_created_at DESC
      LIMIT ?
    `).bind(connectionId, body.sample_size).all();

    if (!sampleData.results || sampleData.results.length === 0) {
      return success(c, {
        total_samples: 0,
        matched: 0,
        filtered_out: 0,
        matches: [],
        message: "No data available for testing"
      });
    }

    // Apply filter
    const queryBuilder = new StripeQueryBuilder();
    const filtered = queryBuilder.applyFilters(
      sampleData.results,
      [body.filter_rule]
    );

    // Return results
    return success(c, {
      total_samples: sampleData.results.length,
      matched: filtered.length,
      filtered_out: sampleData.results.length - filtered.length,
      matches: filtered.slice(0, 5).map(item => ({
        charge_id: item.charge_id,
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        product_id: item.product_id,
        date: item.date,
        // Include sample metadata
        metadata_sample: {
          charge: item.charge_metadata ? JSON.parse(item.charge_metadata).slice(0, 3) : {},
          product: item.product_metadata ? JSON.parse(item.product_metadata).slice(0, 3) : {}
        }
      }))
    });
  }
}

/**
 * GET /v1/connectors/{connection_id}/filters/discover
 * Discover available metadata keys from existing data
 */
export class DiscoverMetadataKeys extends OpenAPIRoute {
  schema = {
    tags: ["Filters"],
    summary: "Discover metadata keys",
    description: "Discover available metadata keys from synced data",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Available metadata keys"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const { params } = await this.getValidatedData<typeof this.schema>();
    const connectionId = params.connection_id;

    // Verify access
    const hasAccess = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Get metadata keys
    const adapter = new StripeAdapter(c.env.DB);
    const keys = await adapter.getMetadataKeys(connectionId);

    // Get cached metadata key info
    const cachedKeys = await c.env.DB.prepare(`
      SELECT object_type, key_path, sample_values, value_type, occurrence_count
      FROM stripe_metadata_keys
      WHERE connection_id = ?
      ORDER BY occurrence_count DESC
    `).bind(connectionId).all();

    return success(c, {
      discovered_keys: keys,
      metadata_info: cachedKeys.results || [],
      total_keys: Object.values(keys).reduce((sum, arr) => sum + arr.length, 0)
    });
  }
}