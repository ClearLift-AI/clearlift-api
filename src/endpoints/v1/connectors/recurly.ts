/**
 * Recurly Connector Endpoints
 *
 * Handle Recurly-specific connection and configuration
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { ConnectorService } from "../../../services/connectors";
import { getSecret } from "../../../utils/secrets";
import { RecurlyAPIProvider } from "../../../services/providers/recurly";
import { OnboardingService } from "../../../services/onboarding";

/**
 * POST /v1/connectors/recurly/connect
 * Connect Recurly account using API key
 */
export class ConnectRecurly extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Connect Recurly account",
    description: "Connect a Recurly account using a private API key",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          organization_id: z.string().min(1),
          api_key: z.string().min(20, "Invalid Recurly API key"),
          lookback_days: z.number().int().min(1).max(730).optional().default(90),
          auto_sync: z.boolean().optional().default(true)
        })
      )
    },
    responses: {
      "201": {
        description: "Recurly account connected successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connection_id: z.string(),
                account_info: z.object({
                  site_id: z.string(),
                  site_subdomain: z.string(),
                  default_currency: z.string()
                })
              })
            })
          }
        }
      },
      "400": { description: "Invalid API key or configuration" },
      "403": { description: "No access to organization" },
      "409": { description: "Recurly account already connected" }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { organization_id, api_key, lookback_days, auto_sync } = data.body;

    // Verify user has access to org
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, organization_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    try {
      // Validate API key with Recurly
      const provider = new RecurlyAPIProvider({ apiKey: api_key });
      const accountInfo = await provider.validateAPIKey();

      // Check if this account is already connected
      const existing = await c.env.DB.prepare(`
        SELECT id FROM platform_connections
        WHERE organization_id = ? AND platform = 'recurly' AND account_id = ? AND is_active = 1
      `).bind(organization_id, accountInfo.site_id).first();

      if (existing) {
        return error(c, "ALREADY_EXISTS", "This Recurly account is already connected", 409);
      }

      // Create connection
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);

      const connectionId = await connectorService.createConnection({
        organizationId: organization_id,
        platform: 'recurly',
        accountId: accountInfo.site_id,
        accountName: accountInfo.site_subdomain,
        connectedBy: session.user_id,
        accessToken: api_key,
        refreshToken: undefined,
        scopes: ['read_only']
      });

      // Store settings
      const settings = JSON.stringify({
        site_subdomain: accountInfo.site_subdomain,
        lookback_days: lookback_days || 90,
        auto_sync: auto_sync !== false,
        initial_sync_completed: false
      });

      await c.env.DB.prepare(`
        UPDATE platform_connections SET settings = ? WHERE id = ?
      `).bind(settings, connectionId).run();

      // Auto-advance onboarding
      const onboarding = new OnboardingService(c.env.DB);
      await onboarding.incrementServicesConnected(session.user_id);

      // Queue initial sync job
      const jobId = crypto.randomUUID();
      const syncEnd = new Date().toISOString();
      const syncStart = new Date(Date.now() - (lookback_days || 90) * 24 * 60 * 60 * 1000).toISOString();

      await c.env.DB.prepare(`
        INSERT INTO sync_jobs (id, organization_id, connection_id, status, job_type, metadata)
        VALUES (?, ?, ?, 'pending', 'full', ?)
      `).bind(
        jobId,
        organization_id,
        connectionId,
        JSON.stringify({
          platform: 'recurly',
          account_id: accountInfo.site_id,
          lookback_days: lookback_days || 90,
          is_initial_sync: true,
          triggered_by: session.user_id
        })
      ).run();

      // Send to queue
      if (c.env.SYNC_QUEUE) {
        await c.env.SYNC_QUEUE.send({
          job_id: jobId,
          connection_id: connectionId,
          organization_id,
          platform: 'recurly',
          account_id: accountInfo.site_id,
          job_type: 'full',
          sync_window: { start: syncStart, end: syncEnd },
          metadata: {
            retry_count: 0,
            created_at: new Date().toISOString(),
            is_initial_sync: true,
            lookback_days: lookback_days || 90
          }
        });
      }

      return success(c, {
        connection_id: connectionId,
        sync_job_id: jobId,
        account_info: {
          site_id: accountInfo.site_id,
          site_subdomain: accountInfo.site_subdomain,
          default_currency: accountInfo.default_currency
        }
      }, undefined, 201);
    } catch (err: any) {
      console.error("Recurly connection error:", err);
      return error(c, "INVALID_API_KEY", err.message || "Failed to validate Recurly API key", 400);
    }
  }
}

/**
 * POST /v1/connectors/recurly/{connection_id}/test
 * Test Recurly connection
 */
export class TestRecurlyConnection extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Test Recurly connection",
    description: "Test that a Recurly connection is working",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      })
    },
    responses: {
      "200": { description: "Connection test results" }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const connectionId = c.req.param('connection_id');

    const connection = await c.env.DB.prepare(`
      SELECT * FROM platform_connections
      WHERE id = ? AND platform = 'recurly' AND is_active = 1
    `).bind(connectionId).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Recurly connection not found", 404);
    }

    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, connection.organization_id as string);

    if (!hasAccess) {
      return error(c, "NOT_FOUND", "Connection not found or access denied", 404);
    }

    try {
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

      const provider = new RecurlyAPIProvider({ apiKey });
      const accountInfo = await provider.validateAPIKey();
      const invoices = await provider.listInvoices({ limit: 5 });

      return success(c, {
        success: true,
        account: {
          id: accountInfo.site_id,
          subdomain: accountInfo.site_subdomain
        },
        recent_invoices: invoices.data.length,
        message: "Connection is working correctly"
      });
    } catch (err: any) {
      console.error('Recurly connection test error:', err);
      return success(c, {
        success: false,
        error: err.message,
        message: "Connection test failed. Please check your API key and try again."
      });
    }
  }
}
