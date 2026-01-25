/**
 * Attentive Connector Endpoints
 *
 * Handle Attentive SMS Marketing connection and configuration
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { ConnectorService } from "../../../services/connectors";
import { getSecret } from "../../../utils/secrets";
import { AttentiveAPIProvider } from "../../../services/providers/attentive";
import { OnboardingService } from "../../../services/onboarding";

/**
 * POST /v1/connectors/attentive/connect
 * Connect Attentive account using API key
 */
export class ConnectAttentive extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Connect Attentive account",
    description: "Connect an Attentive SMS Marketing account using an API key",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          organization_id: z.string().min(1),
          api_key: z.string().min(20, "API key must be at least 20 characters"),
          sync_subscribers: z.boolean().optional().default(true),
          sync_campaigns: z.boolean().optional().default(true),
          sync_messages: z.boolean().optional().default(false),
          sync_journeys: z.boolean().optional().default(true),
          sync_revenue: z.boolean().optional().default(true),
          lookback_days: z.number().int().min(1).max(365).optional().default(30),
          auto_sync: z.boolean().optional().default(true)
        })
      )
    },
    responses: {
      "201": {
        description: "Attentive account connected successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connection_id: z.string(),
                account_info: z.object({
                  company_id: z.string(),
                  company_name: z.string(),
                  timezone: z.string().optional(),
                  country: z.string().optional()
                })
              })
            })
          }
        }
      },
      "400": {
        description: "Invalid API key or configuration"
      },
      "403": {
        description: "No access to organization"
      },
      "409": {
        description: "Attentive account already connected"
      }
    }
  };

  async handle(c: AppContext) {
    // BLOCKED: Attentive integration is not yet ready for production
    // The queue-consumer does not have sync handlers for Attentive data
    return error(c, "SERVICE_UNAVAILABLE", "Attentive integration is temporarily unavailable. This feature is coming soon.", 503);

    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const {
      organization_id,
      api_key,
      sync_subscribers,
      sync_campaigns,
      sync_messages,
      sync_journeys,
      sync_revenue,
      lookback_days,
      auto_sync
    } = data.body;

    // Verify user has access to org
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, organization_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    try {
      // Validate API key with Attentive
      const attentiveProvider = new AttentiveAPIProvider({ apiKey: api_key });
      const accountInfo = await attentiveProvider.validateAPIKey(api_key);

      // Check if this Attentive account is already connected (and active)
      const existing = await c.env.DB.prepare(`
        SELECT id FROM platform_connections
        WHERE organization_id = ? AND platform = 'attentive' AND account_id = ? AND is_active = 1
      `).bind(organization_id, accountInfo.company_id).first();

      if (existing) {
        return error(c, "ALREADY_EXISTS", "This Attentive account is already connected", 409);
      }

      // Create connection
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);

      const connectionId = await connectorService.createConnection({
        organizationId: organization_id,
        platform: 'attentive',
        accountId: accountInfo.company_id,
        accountName: accountInfo.company_name,
        connectedBy: session.user_id,
        accessToken: api_key, // Will be encrypted
        refreshToken: undefined, // Not needed for API key auth
        scopes: ['read_only']
      });

      // Store Attentive-specific settings
      const settings = JSON.stringify({
        sync_subscribers,
        sync_campaigns,
        sync_messages,
        sync_journeys,
        sync_revenue,
        lookback_days,
        auto_sync,
        timezone: accountInfo.timezone,
        country: accountInfo.country
      });

      await c.env.DB.prepare(`
        UPDATE platform_connections
        SET settings = ?
        WHERE id = ?
      `).bind(settings, connectionId).run();

      // Auto-advance onboarding when user connects first service
      const onboarding = new OnboardingService(c.env.DB);
      await onboarding.incrementServicesConnected(session.user_id);

      return success(c, {
        connection_id: connectionId,
        account_info: {
          company_id: accountInfo.company_id,
          company_name: accountInfo.company_name,
          timezone: accountInfo.timezone,
          country: accountInfo.country
        }
      }, undefined, 201);
    } catch (err: any) {
      console.error("Attentive connection error:", err);
      return error(c, "INVALID_API_KEY", err.message || "Failed to validate Attentive API key", 400);
    }
  }
}


/**
 * PUT /v1/connectors/attentive/{connection_id}/config
 * Update Attentive connection configuration
 */
export class UpdateAttentiveConfig extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Update Attentive configuration",
    description: "Update configuration for an Attentive connection",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      body: contentJson(
        z.object({
          sync_subscribers: z.boolean().optional(),
          sync_campaigns: z.boolean().optional(),
          sync_messages: z.boolean().optional(),
          sync_journeys: z.boolean().optional(),
          sync_revenue: z.boolean().optional(),
          lookback_days: z.number().min(1).max(365).optional(),
          auto_sync: z.boolean().optional()
        })
      )
    },
    responses: {
      "200": {
        description: "Configuration updated"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const connectionId = c.req.param('connection_id');
    const data = await this.getValidatedData<typeof this.schema>();

    // First get connection info
    const connection = await c.env.DB.prepare(`
      SELECT * FROM platform_connections
      WHERE id = ? AND platform = 'attentive' AND is_active = 1
    `).bind(connectionId).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Attentive connection not found", 404);
    }

    // Check access using D1Adapter (handles super admin bypass)
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id as string);

    if (!hasAccess) {
      return error(c, "NOT_FOUND", "Attentive connection not found or access denied", 404);
    }

    // Check role for non-super-admins
    const user = await d1.getUser(session.user_id);
    if (!Boolean(user?.is_admin)) {
      const member = await c.env.DB.prepare(`
        SELECT role FROM organization_members WHERE user_id = ? AND organization_id = ?
      `).bind(session.user_id, connection.organization_id).first<{role: string}>();
      if (member?.role === 'viewer') {
        return error(c, "FORBIDDEN", "Insufficient permissions to update configuration", 403);
      }
    }

    // Merge new settings with existing
    const existingSettings = connection.settings ? JSON.parse(connection.settings as string) : {};
    const newSettings = {
      ...existingSettings,
      ...data.body
    };

    await c.env.DB.prepare(`
      UPDATE platform_connections
      SET settings = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(JSON.stringify(newSettings), connectionId).run();

    return success(c, { message: "Configuration updated successfully" });
  }
}


/**
 * POST /v1/connectors/attentive/{connection_id}/sync
 * Trigger manual sync for Attentive connection
 */
export class TriggerAttentiveSync extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Trigger Attentive sync",
    description: "Manually trigger a sync for an Attentive connection",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      body: contentJson(
        z.object({
          sync_type: z.enum(['full', 'incremental']).default('incremental'),
          date_from: z.string().optional(),
          date_to: z.string().optional()
        })
      )
    },
    responses: {
      "202": {
        description: "Sync job queued"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const connectionId = c.req.param('connection_id');
    const body = await c.req.json();

    // First get connection info
    const connection = await c.env.DB.prepare(`
      SELECT * FROM platform_connections
      WHERE id = ? AND platform = 'attentive' AND is_active = 1
    `).bind(connectionId).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Attentive connection not found", 404);
    }

    // Check access using D1Adapter (handles super admin bypass)
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id as string);

    if (!hasAccess) {
      return error(c, "NOT_FOUND", "Attentive connection not found or access denied", 404);
    }

    // Check if there's already a pending/running sync
    const activeSync = await c.env.DB.prepare(`
      SELECT id FROM sync_jobs
      WHERE connection_id = ? AND status IN ('pending', 'running')
    `).bind(connectionId).first();

    if (activeSync) {
      return error(c, "CONFLICT", "A sync is already in progress", 409);
    }

    // Parse settings
    const settings = connection.settings ? JSON.parse(connection.settings as string) : {};

    // Queue new sync job
    const jobId = crypto.randomUUID();

    const metadata = {
      platform: 'attentive',
      account_id: connection.account_id,
      date_from: body.date_from,
      date_to: body.date_to,
      lookback_days: settings.lookback_days || 30,
      sync_subscribers: settings.sync_subscribers ?? true,
      sync_campaigns: settings.sync_campaigns ?? true,
      sync_messages: settings.sync_messages ?? false,
      sync_journeys: settings.sync_journeys ?? true,
      sync_revenue: settings.sync_revenue ?? true,
      triggered_by: session.user_id,
      retry_count: 0
    };

    // Create job record in database
    await c.env.DB.prepare(`
      INSERT INTO sync_jobs (
        id, organization_id, connection_id,
        status, job_type, metadata
      ) VALUES (?, ?, ?, 'pending', ?, ?)
    `).bind(
      jobId,
      connection.organization_id,
      connectionId,
      body.sync_type || 'incremental',
      JSON.stringify(metadata)
    ).run();

    // Send job to queue for processing
    if (c.env.SYNC_QUEUE) {
      try {
        const queueMessage = {
          job_id: jobId,
          connection_id: connectionId,
          organization_id: connection.organization_id,
          platform: 'attentive',
          account_id: connection.account_id,
          job_type: body.sync_type || 'incremental',
          sync_window: {
            start: body.date_from || new Date(Date.now() - (settings.lookback_days || 30) * 24 * 60 * 60 * 1000).toISOString(),
            end: body.date_to || new Date().toISOString()
          },
          metadata: {
            ...metadata,
            created_at: new Date().toISOString(),
            priority: 'normal'
          }
        };
        await c.env.SYNC_QUEUE.send(queueMessage);
      } catch (queueError) {
        console.error('Queue send error:', queueError);
      }
    }

    return success(c, {
      job_id: jobId,
      message: "Sync job queued successfully"
    }, undefined, 202);
  }
}


/**
 * POST /v1/connectors/attentive/{connection_id}/test
 * Test Attentive connection
 */
export class TestAttentiveConnection extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Test Attentive connection",
    description: "Test that an Attentive connection is working",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Connection test results"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const connectionId = c.req.param('connection_id');

    // First get connection info
    const connection = await c.env.DB.prepare(`
      SELECT * FROM platform_connections
      WHERE id = ? AND platform = 'attentive' AND is_active = 1
    `).bind(connectionId).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Attentive connection not found", 404);
    }

    // Check access using D1Adapter (handles super admin bypass)
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id as string);

    if (!hasAccess) {
      return error(c, "NOT_FOUND", "Attentive connection not found or access denied", 404);
    }

    try {
      // Get API key
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const apiKey = await connectorService.getAccessToken(connectionId);

      if (!apiKey) {
        return success(c, {
          success: false,
          error: "API key not found",
          message: "The connection appears to be corrupted. Please reconnect."
        });
      }

      // Test API key
      const attentiveProvider = new AttentiveAPIProvider({ apiKey });
      const testResult = await attentiveProvider.testConnection();

      if (!testResult.success) {
        return success(c, {
          success: false,
          error: testResult.error,
          message: "Connection test failed. Please check your API key and try again."
        });
      }

      return success(c, {
        success: true,
        account: testResult.account,
        message: "Connection is working correctly"
      });

    } catch (err: any) {
      console.error('Attentive connection test error:', err);

      return success(c, {
        success: false,
        error: err.message,
        message: "Connection test failed. Please check your API key and try again."
      });
    }
  }
}
