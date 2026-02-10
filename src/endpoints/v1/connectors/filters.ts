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
import { D1Adapter } from "../../../adapters/d1";
import { structuredLog } from "../../../utils/structured-logger";

/**
 * Helper to check if user has access to a connection (handles super admin bypass)
 * Returns the connection's organization_id if access granted, null otherwise
 */
async function checkConnectionAccess(
  c: AppContext,
  connectionId: string,
  userId: string
): Promise<{ hasAccess: boolean; organizationId: string | null; connection: any }> {
  // Get connection info first
  const connection = await c.env.DB.prepare(`
    SELECT id, organization_id, platform, is_active
    FROM platform_connections
    WHERE id = ? AND is_active = 1
  `).bind(connectionId).first();

  if (!connection) {
    return { hasAccess: false, organizationId: null, connection: null };
  }

  // Check access using D1Adapter (handles super admin bypass)
  const d1 = new D1Adapter(c.env.DB);
  const hasAccess = await d1.checkOrgAccess(userId, connection.organization_id as string);

  return {
    hasAccess,
    organizationId: connection.organization_id as string,
    connection
  };
}

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

    // Verify connection exists and user has access (handles super admin bypass)
    const { hasAccess, connection } = await checkConnectionAccess(c, connectionId, session.user_id);

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found", 404);
    }

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
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
    }, undefined, 201);
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

    // Verify access (handles super admin bypass)
    const { hasAccess, connection } = await checkConnectionAccess(c, connectionId, session.user_id);

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found", 404);
    }

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

    // Verify access (handles super admin bypass)
    const { hasAccess, connection } = await checkConnectionAccess(c, connection_id, session.user_id);

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found", 404);
    }

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Verify filter exists
    const filter = await c.env.DB.prepare(`
      SELECT * FROM connector_filter_rules
      WHERE id = ? AND connection_id = ?
    `).bind(filter_id, connection_id).first();

    if (!filter) {
      return error(c, "NOT_FOUND", "Filter not found", 404);
    }

    // Validate if conditions changed
    if (body.conditions) {
      const queryBuilder = new StripeQueryBuilder();
      const validation = queryBuilder.validateFilter({
        name: (body.name as string) || (filter.name as string),
        operator: (body.operator as 'AND' | 'OR') || (filter.operator as 'AND' | 'OR'),
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

    // Verify access (handles super admin bypass)
    const { hasAccess, connection, organizationId } = await checkConnectionAccess(c, connection_id, session.user_id);

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found", 404);
    }

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Check role (super admins can delete, viewers cannot)
    const d1 = new D1Adapter(c.env.DB);
    const user = await d1.getUser(session.user_id);
    const isSuperAdmin = Boolean(user?.is_admin);

    if (!isSuperAdmin && organizationId) {
      // Check role for non-super-admins
      const member = await c.env.DB.prepare(`
        SELECT role FROM organization_members
        WHERE user_id = ? AND organization_id = ?
      `).bind(session.user_id, organizationId).first<{ role: string }>();

      if (member?.role === 'viewer') {
        return error(c, "FORBIDDEN", "Insufficient permissions", 403);
      }
    }

    // Verify filter exists
    const filter = await c.env.DB.prepare(`
      SELECT id FROM connector_filter_rules
      WHERE id = ? AND connection_id = ?
    `).bind(filter_id, connection_id).first();

    if (!filter) {
      return error(c, "NOT_FOUND", "Filter not found", 404);
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

    // Verify access (handles super admin bypass)
    const { hasAccess, connection } = await checkConnectionAccess(c, connectionId, session.user_id);

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found", 404);
    }

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Get sample data from D1 ANALYTICS_DB (stripe_charges table)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    let sampleData: any[] = [];
    try {
      // Query stripe_charges from ANALYTICS_DB
      const result = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          id,
          charge_id,
          customer_id,
          amount_cents,
          currency,
          status,
          payment_method_type,
          stripe_created_at,
          metadata
        FROM stripe_charges
        WHERE connection_id = ?
          AND stripe_created_at >= ?
          AND stripe_created_at <= ?
        ORDER BY stripe_created_at DESC
        LIMIT ?
      `).bind(
        connectionId,
        startDate.toISOString(),
        endDate.toISOString(),
        body.sample_size
      ).all();

      // Transform D1 results to match expected format
      sampleData = (result.results || []).map((row: any) => {
        const metadata = row.metadata ? JSON.parse(row.metadata) : {};
        return {
          charge_id: row.charge_id,
          customer_id: row.customer_id,
          amount: row.amount_cents / 100,
          currency: row.currency,
          status: row.status,
          payment_method_type: row.payment_method_type,
          date: row.stripe_created_at,
          charge_metadata: metadata.charge || metadata,
          product_metadata: metadata.product || {}
        };
      });
    } catch (err: any) {
      structuredLog('ERROR', 'Failed to get sample data from D1', { endpoint: 'POST /v1/connectors/:id/filters/test', error: err instanceof Error ? err.message : String(err) });
      return success(c, {
        total_samples: 0,
        matched: 0,
        filtered_out: 0,
        matches: [],
        message: "No data available for testing. Complete a sync first."
      });
    }

    if (sampleData.length === 0) {
      return success(c, {
        total_samples: 0,
        matched: 0,
        filtered_out: 0,
        matches: [],
        message: "No data available for testing. Complete a sync first."
      });
    }

    // Apply filter
    const queryBuilder = new StripeQueryBuilder();
    const filtered = queryBuilder.applyFilters(
      sampleData,
      [body.filter_rule]
    );

    // Return results
    return success(c, {
      total_samples: sampleData.length,
      matched: filtered.length,
      filtered_out: sampleData.length - filtered.length,
      matches: filtered.slice(0, 5).map((item: any) => ({
        charge_id: item.charge_id,
        amount: item.amount,
        currency: item.currency,
        status: item.status,
        product_id: item.product_id,
        date: item.date,
        // Include sample metadata from D1
        metadata_sample: {
          charge: item.charge_metadata || {},
          product: item.product_metadata || {}
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

    // Verify access (handles super admin bypass)
    const { hasAccess, connection } = await checkConnectionAccess(c, connectionId, session.user_id);

    if (!connection) {
      return error(c, "NOT_FOUND", "Connection not found", 404);
    }

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "Access denied", 403);
    }

    // Discover metadata keys from D1 ANALYTICS_DB by sampling recent charges
    let keys: Record<string, string[]> = {
      charge: [],
      product: []
    };

    try {
      // Get recent charges with metadata from D1
      const result = await c.env.ANALYTICS_DB.prepare(`
        SELECT metadata
        FROM stripe_charges
        WHERE connection_id = ?
          AND metadata IS NOT NULL
          AND metadata != '{}'
        ORDER BY stripe_created_at DESC
        LIMIT 100
      `).bind(connectionId).all();

      // Extract unique keys from metadata JSON
      const chargeKeys = new Set<string>();
      const productKeys = new Set<string>();

      for (const row of (result.results || []) as any[]) {
        try {
          const metadata = JSON.parse(row.metadata || '{}');

          // Charge-level metadata keys
          if (metadata.charge && typeof metadata.charge === 'object') {
            Object.keys(metadata.charge).forEach(k => chargeKeys.add(k));
          } else if (!metadata.product) {
            // Top-level is charge metadata
            Object.keys(metadata).forEach(k => chargeKeys.add(k));
          }

          // Product-level metadata keys
          if (metadata.product && typeof metadata.product === 'object') {
            Object.keys(metadata.product).forEach(k => productKeys.add(k));
          }
        } catch (parseErr) {
          // Skip invalid JSON
        }
      }

      keys.charge = Array.from(chargeKeys).sort();
      keys.product = Array.from(productKeys).sort();
    } catch (err: any) {
      structuredLog('ERROR', 'Failed to discover metadata keys from D1', { endpoint: 'GET /v1/connectors/:id/filters/discover', error: err instanceof Error ? err.message : String(err) });
      // Return empty keys if D1 query fails - don't block the response
    }

    // Get cached metadata key info from main D1 DB (may not exist for new connections)
    let cachedKeys: any[] = [];
    try {
      const result = await c.env.DB.prepare(`
        SELECT object_type, key_path, sample_values, value_type, occurrence_count
        FROM stripe_metadata_keys
        WHERE connection_id = ?
        ORDER BY occurrence_count DESC
      `).bind(connectionId).all();
      cachedKeys = result.results || [];
    } catch (err: any) {
      structuredLog('ERROR', 'Failed to get cached metadata keys', { endpoint: 'GET /v1/connectors/:id/filters/discover', error: err instanceof Error ? err.message : String(err) });
      // Table may not exist - not a critical error
    }

    return success(c, {
      discovered_keys: keys,
      metadata_info: cachedKeys,
      total_keys: keys.charge.length + keys.product.length
    });
  }
}