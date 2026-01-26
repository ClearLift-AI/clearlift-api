/**
 * Connector Registry API Endpoints
 *
 * Public endpoints for reading connector configuration.
 * Admin endpoints for managing connector registry.
 *
 * @see /services/connector-registry.ts for service implementation
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { ConnectorRegistryService, ConnectorType, ConnectorCategory } from "../../../services/connector-registry";
import { success, error } from "../../../utils/response";

// Zod schemas for API validation
const ConnectorEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  fields: z.array(z.string()),
});

const ConnectorDefinitionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  platform_id: z.string().nullable(),
  connector_type: z.enum(['ad_platform', 'revenue', 'crm', 'events', 'scheduling', 'email', 'sms']),
  category: z.enum(['advertising', 'ecommerce', 'payments', 'crm', 'analytics', 'communication', 'field_service']),
  auth_type: z.enum(['oauth2', 'oauth', 'api_key', 'basic', 'internal']),
  description: z.string().nullable(),
  documentation_url: z.string().nullable(),
  logo_url: z.string().nullable(),
  icon_name: z.string().nullable(),
  icon_color: z.string(),
  sort_order: z.number(),
  is_active: z.boolean(),
  is_beta: z.boolean(),
  supports_sync: z.boolean(),
  supports_realtime: z.boolean(),
  supports_webhooks: z.boolean(),
  events: z.array(ConnectorEventSchema),
  default_concurrency: z.number(),
  rate_limit_per_hour: z.number().nullable(),
  default_lookback_days: z.number(),
  default_sync_interval_hours: z.number(),
  theme_bg_color: z.string().nullable(),
  theme_border_color: z.string().nullable(),
  theme_text_color: z.string().nullable(),
  has_actual_value: z.boolean(),
  value_field: z.string().nullable(),
  permissions_description: z.string().nullable(),
});

const ConnectorSummarySchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  connector_type: z.string(),
  category: z.string(),
  icon_name: z.string().nullable(),
  icon_color: z.string(),
  is_active: z.boolean(),
  is_beta: z.boolean(),
  sort_order: z.number(),
});

/**
 * GET /v1/connectors/registry - List all connectors in the registry
 * Public endpoint - no auth required for reading connector config
 */
export class ListConnectorRegistry extends OpenAPIRoute {
  public schema = {
    tags: ["Connector Registry"],
    summary: "List all connectors in the registry",
    operationId: "list-connector-registry",
    request: {
      query: z.object({
        type: z.enum(['ad_platform', 'revenue', 'crm', 'events', 'scheduling', 'email', 'sms']).optional(),
        category: z.enum(['advertising', 'ecommerce', 'payments', 'crm', 'analytics', 'communication', 'field_service']).optional(),
        active_only: z.enum(['true', 'false']).optional().default('true'),
        include_internal: z.enum(['true', 'false']).optional().default('false'),
        format: z.enum(['full', 'summary']).optional().default('full'),
      }),
    },
    responses: {
      "200": {
        description: "List of connectors",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connectors: z.array(ConnectorDefinitionSchema),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { type, category, active_only, include_internal, format } = data.query;

    const registryService = new ConnectorRegistryService(c.env.DB);

    const options = {
      type: type as ConnectorType | undefined,
      category: category as ConnectorCategory | undefined,
      activeOnly: active_only === 'true',
      includeInternal: include_internal === 'true',
    };

    if (format === 'summary') {
      const connectors = await registryService.listConnectorSummaries(options);
      return success(c, { connectors });
    }

    const connectors = await registryService.listConnectors(options);
    return success(c, { connectors });
  }
}

/**
 * GET /v1/connectors/registry/:provider - Get a single connector by provider
 * Public endpoint
 */
export class GetConnectorFromRegistry extends OpenAPIRoute {
  public schema = {
    tags: ["Connector Registry"],
    summary: "Get a single connector from the registry",
    operationId: "get-connector-from-registry",
    request: {
      params: z.object({
        provider: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Connector details",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connector: ConnectorDefinitionSchema,
              }),
            }),
          },
        },
      },
      "404": {
        description: "Connector not found",
      },
    },
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider } = data.params;

    const registryService = new ConnectorRegistryService(c.env.DB);
    const connector = await registryService.getConnector(provider);

    if (!connector) {
      return error(c, "NOT_FOUND", `Connector '${provider}' not found`, 404);
    }

    return success(c, { connector });
  }
}

/**
 * GET /v1/connectors/registry/:provider/events - Get events schema for Flow Builder
 * Public endpoint
 */
export class GetConnectorEvents extends OpenAPIRoute {
  public schema = {
    tags: ["Connector Registry"],
    summary: "Get events schema for a connector",
    operationId: "get-connector-events",
    request: {
      params: z.object({
        provider: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "Connector events schema",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                provider: z.string(),
                events: z.array(ConnectorEventSchema),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { provider } = data.params;

    const registryService = new ConnectorRegistryService(c.env.DB);
    const events = await registryService.getConnectorEvents(provider);

    return success(c, { provider, events });
  }
}

/**
 * GET /v1/connectors/registry/types/:type/platform-ids - Get platform IDs for SQL queries
 * Public endpoint - useful for dynamic SQL in cron workers
 */
export class GetPlatformIds extends OpenAPIRoute {
  public schema = {
    tags: ["Connector Registry"],
    summary: "Get platform IDs for a connector type",
    operationId: "get-platform-ids",
    request: {
      params: z.object({
        type: z.enum(['ad_platform', 'revenue', 'crm', 'events', 'scheduling', 'email', 'sms']),
      }),
    },
    responses: {
      "200": {
        description: "Platform IDs",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                type: z.string(),
                platform_ids: z.array(z.string()),
                sql_in_clause: z.string(),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>();
    const { type } = data.params;

    const registryService = new ConnectorRegistryService(c.env.DB);
    const platformIds = await registryService.getPlatformIds(type as ConnectorType);
    const sqlInClause = await registryService.getPlatformInClause(type as ConnectorType);

    return success(c, {
      type,
      platform_ids: platformIds,
      sql_in_clause: sqlInClause,
    });
  }
}

// =====================================================================
// ADMIN ENDPOINTS (require auth + admin check)
// =====================================================================

/**
 * POST /v1/admin/connectors/registry - Create a new connector
 * Admin only
 */
export class AdminCreateConnector extends OpenAPIRoute {
  public schema = {
    tags: ["Connector Registry (Admin)"],
    summary: "Create a new connector in the registry",
    operationId: "admin-create-connector",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          provider: z.string().min(1).max(50),
          name: z.string().min(1).max(100),
          connector_type: z.enum(['ad_platform', 'revenue', 'crm', 'events', 'scheduling', 'email', 'sms']),
          category: z.enum(['advertising', 'ecommerce', 'payments', 'crm', 'analytics', 'communication', 'field_service']),
          auth_type: z.enum(['oauth2', 'oauth', 'api_key', 'basic', 'internal']),
          description: z.string().optional(),
          icon_name: z.string().optional(),
          icon_color: z.string().optional(),
          events_schema: z.array(ConnectorEventSchema).optional(),
        })
      ),
    },
    responses: {
      "201": {
        description: "Connector created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connector: ConnectorDefinitionSchema,
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get("session");

    // Check admin status
    const userResult = await c.env.DB.prepare(`
      SELECT is_admin FROM users WHERE id = ?
    `).bind(session.user_id).first<{ is_admin: number }>();

    if (!userResult?.is_admin) {
      return error(c, "FORBIDDEN", "Admin access required", 403);
    }

    const body = await c.req.json() as {
      provider: string;
      name: string;
      connector_type: ConnectorType;
      category: ConnectorCategory;
      auth_type: 'oauth2' | 'oauth' | 'api_key' | 'basic' | 'internal';
      description?: string;
      icon_name?: string;
      icon_color?: string;
      events_schema?: { id: string; name: string; fields: string[] }[];
    };

    const registryService = new ConnectorRegistryService(c.env.DB);

    // Check if provider already exists
    const existing = await registryService.getConnector(body.provider);
    if (existing) {
      return error(c, "CONFLICT", `Connector '${body.provider}' already exists`, 409);
    }

    const connector = await registryService.createConnector({
      provider: body.provider,
      name: body.name,
      connector_type: body.connector_type,
      category: body.category,
      auth_type: body.auth_type,
      description: body.description,
      icon_name: body.icon_name,
      icon_color: body.icon_color,
      events_schema: body.events_schema,
    });

    return c.json({ success: true, data: { connector } }, 201);
  }
}

/**
 * PATCH /v1/admin/connectors/registry/:provider - Update a connector
 * Admin only
 */
export class AdminUpdateConnector extends OpenAPIRoute {
  public schema = {
    tags: ["Connector Registry (Admin)"],
    summary: "Update a connector in the registry",
    operationId: "admin-update-connector",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        provider: z.string(),
      }),
      body: contentJson(
        z.object({
          name: z.string().optional(),
          connector_type: z.enum(['ad_platform', 'revenue', 'crm', 'events', 'scheduling', 'email', 'sms']).optional(),
          category: z.enum(['advertising', 'ecommerce', 'payments', 'crm', 'analytics', 'communication', 'field_service']).optional(),
          description: z.string().optional(),
          documentation_url: z.string().optional(),
          icon_name: z.string().optional(),
          icon_color: z.string().optional(),
          sort_order: z.number().optional(),
          is_active: z.boolean().optional(),
          is_beta: z.boolean().optional(),
          supports_sync: z.boolean().optional(),
          supports_realtime: z.boolean().optional(),
          supports_webhooks: z.boolean().optional(),
          events: z.array(ConnectorEventSchema).optional(),
          default_concurrency: z.number().optional(),
          rate_limit_per_hour: z.number().nullable().optional(),
          default_lookback_days: z.number().optional(),
          default_sync_interval_hours: z.number().optional(),
          theme_bg_color: z.string().nullable().optional(),
          theme_border_color: z.string().nullable().optional(),
          theme_text_color: z.string().nullable().optional(),
          has_actual_value: z.boolean().optional(),
          value_field: z.string().nullable().optional(),
          permissions_description: z.string().nullable().optional(),
          platform_id: z.string().nullable().optional(),
        })
      ),
    },
    responses: {
      "200": {
        description: "Connector updated",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connector: ConnectorDefinitionSchema,
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const session = c.get("session");

    // Check admin status
    const userResult = await c.env.DB.prepare(`
      SELECT is_admin FROM users WHERE id = ?
    `).bind(session.user_id).first<{ is_admin: number }>();

    if (!userResult?.is_admin) {
      return error(c, "FORBIDDEN", "Admin access required", 403);
    }

    // Get provider from URL params
    const provider = c.req.param('provider');
    if (!provider) {
      return error(c, "INVALID_REQUEST", "Provider parameter is required", 400);
    }

    const updates = await c.req.json() as Partial<{
      name: string;
      connector_type: ConnectorType;
      category: ConnectorCategory;
      description: string;
      documentation_url: string;
      icon_name: string;
      icon_color: string;
      sort_order: number;
      is_active: boolean;
      is_beta: boolean;
      supports_sync: boolean;
      supports_realtime: boolean;
      supports_webhooks: boolean;
      events: { id: string; name: string; fields: string[] }[];
      default_concurrency: number;
      rate_limit_per_hour: number | null;
      default_lookback_days: number;
      default_sync_interval_hours: number;
      theme_bg_color: string | null;
      theme_border_color: string | null;
      theme_text_color: string | null;
      has_actual_value: boolean;
      value_field: string | null;
      permissions_description: string | null;
      platform_id: string | null;
    }>;

    const registryService = new ConnectorRegistryService(c.env.DB);

    try {
      const connector = await registryService.updateConnector(provider, updates);
      return success(c, { connector });
    } catch (err: any) {
      if (err.message === 'Connector not found') {
        return error(c, "NOT_FOUND", `Connector '${provider}' not found`, 404);
      }
      throw err;
    }
  }
}
