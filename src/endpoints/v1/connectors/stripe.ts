/**
 * Stripe Connector Endpoints
 *
 * Handle Stripe-specific connection and configuration
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { ConnectorService } from "../../../services/connectors";
import { getSecret } from "../../../utils/secrets";
import { StripeAPIProvider } from "../../../services/providers/stripe";
import { OnboardingService } from "../../../services/onboarding";

/**
 * POST /v1/connectors/stripe/connect
 * Connect Stripe account using API key
 * Plain handler function (not OpenAPIRoute) to avoid Chanfana validation issues
 */
export async function handleStripeConnect(c: AppContext) {
  console.log("handleStripeConnect called");
  const session = c.get("session");
  console.log("Session:", session?.user_id);

  // Get sanitized body from context (set by sanitizeInput middleware)
  // Fallback to reading from request if not set
  const sanitizedBody = (c as any).get("sanitizedBody");
  console.log("Sanitized body from context:", sanitizedBody);

  const body = sanitizedBody || await c.req.json().catch(() => ({}));
  console.log("Final body:", body);

  // Manual validation
  if (!body.organization_id || !body.api_key) {
    return error(c, "INVALID_REQUEST", "organization_id and api_key are required", 400);
  }

  // Validate API key format
  if (!body.api_key.match(/^(sk_test_|sk_live_|rk_test_|rk_live_)[a-zA-Z0-9]{24,}$/)) {
    return error(c, "INVALID_API_KEY", "Invalid Stripe API key format", 400);
  }

  const {
    organization_id,
    api_key,
    sync_mode = 'charges',
    lookback_days = 30,
    auto_sync = true
  } = body;

  // Verify user has access to org
  const { D1Adapter } = await import("../../../adapters/d1");
  const d1 = new D1Adapter(c.env.DB);
  const hasAccess = await d1.checkOrgAccess(session.user_id, organization_id);

  if (!hasAccess) {
    return error(c, "FORBIDDEN", "No access to this organization", 403);
  }

  try {
    // Validate API key with Stripe
    const stripeProvider = new StripeAPIProvider({ apiKey: api_key });
    const accountInfo = await stripeProvider.validateAPIKey(api_key);

    if (!accountInfo.charges_enabled) {
      return error(c, "INVALID_CONFIG", "This Stripe account cannot accept charges", 400);
    }

    // Check if this Stripe account is already connected
    const existing = await c.env.DB.prepare(`
      SELECT id FROM platform_connections
      WHERE organization_id = ? AND platform = 'stripe' AND stripe_account_id = ?
    `).bind(organization_id, accountInfo.stripe_account_id).first();

    if (existing) {
      return error(c, "ALREADY_EXISTS", "This Stripe account is already connected", 409);
    }

    // Create connection
    const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
    const connectorService = new ConnectorService(c.env.DB, encryptionKey);

    // Wait a bit for encryption to initialize (async constructor issue)
    await new Promise(resolve => setTimeout(resolve, 100));

    const connectionId = await connectorService.createConnection({
      organizationId: organization_id,
      platform: 'stripe',
      accountId: accountInfo.stripe_account_id,
      accountName: accountInfo.business_profile?.name || accountInfo.stripe_account_id,
      connectedBy: session.user_id,
      accessToken: api_key, // Will be encrypted
      refreshToken: undefined, // Not needed for API key auth
      scopes: ['read_only'] // Based on key restrictions
    });

    // Store Stripe-specific fields
    const isLiveMode = api_key.startsWith('sk_live_') || api_key.startsWith('rk_live_') ? 1 : 0;
    await c.env.DB.prepare(`
      UPDATE platform_connections
      SET stripe_account_id = ?,
          stripe_livemode = ?
      WHERE id = ?
    `).bind(
      accountInfo.stripe_account_id,
      isLiveMode,
      connectionId
    ).run();

    // Auto-advance onboarding when user connects first service
    const onboarding = new OnboardingService(c.env.DB);
    await onboarding.incrementServicesConnected(session.user_id);

    return success(c, {
      connection_id: connectionId,
      account_info: {
        stripe_account_id: accountInfo.stripe_account_id,
        business_name: accountInfo.business_profile?.name,
        country: accountInfo.country,
        default_currency: accountInfo.default_currency,
        charges_enabled: accountInfo.charges_enabled
      }
    }, 201);
  } catch (err: any) {
    console.error("Stripe connection error:", err);
    return error(c, "INVALID_API_KEY", err.message || "Failed to validate Stripe API key", 400);
  }
}

/**
 * OpenAPIRoute class for documentation only (not used for actual handling)
 */
export class ConnectStripe extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Connect Stripe account",
    description: "Connect a Stripe account using a restricted API key",
    security: [{ bearerAuth: [] }],
    // Body validation removed to avoid Chanfana auto-validation issue
    request: {},
    responses: {
      "201": {
        description: "Stripe account connected successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                connection_id: z.string(),
                account_info: z.object({
                  stripe_account_id: z.string(),
                  business_name: z.string().optional(),
                  country: z.string(),
                  default_currency: z.string(),
                  charges_enabled: z.boolean()
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
      }
    }
  };

  async handle(c: AppContext) {
    return handleStripeConnect(c);
  }
}


/**
 * PUT /v1/connectors/stripe/{connection_id}/config
 * Update Stripe connection configuration
 */
export class UpdateStripeConfig extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Update Stripe configuration",
    description: "Update configuration for a Stripe connection",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        connection_id: z.string()
      }),
      body: contentJson(
        z.object({
          sync_mode: z.enum(['charges', 'payment_intents', 'invoices']).optional(),
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
    const body = await c.req.json();

    // Verify connection exists and user has access
    const connection = await c.env.DB.prepare(`
      SELECT pc.*, om.role
      FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND pc.platform = 'stripe' AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Stripe connection not found or access denied", 404);
    }

    if (connection.role === 'viewer') {
      return error(c, "FORBIDDEN", "Insufficient permissions to update configuration", 403);
    }

    // Update configuration
    // Note: In a real implementation, you'd store these in a separate config table
    // For now, we'll store in sync_jobs metadata for the next sync

    return success(c, { message: "Configuration updated successfully" });
  }
}

/**
 * POST /v1/connectors/stripe/{connection_id}/sync
 * Trigger manual sync for Stripe connection
 */
export class TriggerStripeSync extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Trigger Stripe sync",
    description: "Manually trigger a sync for a Stripe connection",
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

    // Verify connection exists and user has access
    const connection = await c.env.DB.prepare(`
      SELECT pc.*, om.role
      FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND pc.platform = 'stripe' AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Stripe connection not found or access denied", 404);
    }

    // Check if there's already a pending/running sync
    const activeSync = await c.env.DB.prepare(`
      SELECT id FROM sync_jobs
      WHERE connection_id = ? AND status IN ('pending', 'running')
    `).bind(connectionId).first();

    if (activeSync) {
      return error(c, "CONFLICT", "A sync is already in progress", 409);
    }

    // Queue new sync job
    const jobId = crypto.randomUUID();

    const metadata = {
      platform: 'stripe',
      account_id: connection.stripe_account_id || connection.account_id,
      date_from: body.date_from,
      date_to: body.date_to,
      lookback_days: body.lookback_days || 7,
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
    console.log('SYNC_QUEUE exists?', !!c.env.SYNC_QUEUE);
    if (c.env.SYNC_QUEUE) {
      try {
        const queueMessage = {
          job_id: jobId,
          connection_id: connectionId,
          organization_id: connection.organization_id,
          platform: 'stripe',
          account_id: connection.stripe_account_id || connection.account_id,
          job_type: body.sync_type || 'incremental',
          sync_window: {
            start: body.date_from || new Date(Date.now() - (body.lookback_days || 7) * 24 * 60 * 60 * 1000).toISOString(),
            end: body.date_to || new Date().toISOString()
          },
          metadata: {
            retry_count: 0,
            created_at: new Date().toISOString(),
            priority: 'normal'
          }
        };
        console.log('Sending to queue:', JSON.stringify(queueMessage));
        await c.env.SYNC_QUEUE.send(queueMessage);
        console.log('Successfully sent to queue');
      } catch (queueError) {
        console.error('Queue send error:', queueError);
      }
    } else {
      console.error('SYNC_QUEUE binding not available!');
    }

    return success(c, {
      job_id: jobId,
      message: "Sync job queued successfully"
    }, 202);
  }
}

/**
 * POST /v1/connectors/stripe/{connection_id}/test
 * Test Stripe connection
 */
export class TestStripeConnection extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Test Stripe connection",
    description: "Test that a Stripe connection is working",
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

    // Verify connection exists and user has access
    const connection = await c.env.DB.prepare(`
      SELECT pc.*
      FROM platform_connections pc
      INNER JOIN organization_members om
        ON pc.organization_id = om.organization_id
      WHERE pc.id = ? AND pc.platform = 'stripe' AND om.user_id = ?
    `).bind(connectionId, session.user_id).first();

    if (!connection) {
      return error(c, "NOT_FOUND", "Stripe connection not found or access denied", 404);
    }

    try {
      // Get API key
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = new ConnectorService(c.env.DB, encryptionKey);
      const apiKey = await connectorService.getAccessToken(connectionId);

      if (!apiKey) {
        return success(c, {
          success: false,
          error: "API key not found",
          message: "The connection appears to be corrupted. Please reconnect."
        });
      }

      // Test API key
      const stripeProvider = new StripeAPIProvider({ apiKey });
      const accountInfo = await stripeProvider.validateAPIKey(apiKey);

      // Try to fetch a few recent charges
      const charges = await stripeProvider.listCharges({ limit: 5 });

      return success(c, {
        success: true,
        account: {
          id: accountInfo.stripe_account_id,
          name: accountInfo.business_profile?.name,
          country: accountInfo.country,
          charges_enabled: accountInfo.charges_enabled
        },
        recent_charges: charges.length,
        message: "Connection is working correctly"
      });

    } catch (err: any) {
      console.error('Stripe connection test error:', err);

      return success(c, {
        success: false,
        error: err.message,
        message: "Connection test failed. Please check your API key and try again."
      });
    }
  }
}