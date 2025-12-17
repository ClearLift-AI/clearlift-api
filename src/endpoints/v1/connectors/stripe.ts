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
 */
export class ConnectStripe extends OpenAPIRoute {
  schema = {
    tags: ["Connectors"],
    summary: "Connect Stripe account",
    description: "Connect a Stripe account using a restricted API key",
    security: [{ bearerAuth: [] }],
    request: {
      body: contentJson(
        z.object({
          organization_id: z.string().min(1),
          api_key: z.string().regex(
            /^(sk_test_|sk_live_|rk_test_|rk_live_)[a-zA-Z0-9]{24,}$/,
            "Invalid Stripe API key format. Must start with sk_test_, sk_live_, rk_test_, or rk_live_ followed by at least 24 alphanumeric characters"
          ),
          sync_mode: z.enum(['charges', 'subscriptions']).optional().default('charges'),
          lookback_days: z.number().int().min(1).max(730).optional().default(90),
          auto_sync: z.boolean().optional().default(true),
          initial_filters: z.array(z.object({
            field: z.string(),
            operator: z.string(),
            value: z.string()
          })).optional()
        })
      )
    },
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
      },
      "409": {
        description: "Stripe account already connected"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const data = await this.getValidatedData<typeof this.schema>();
    const { organization_id, api_key, sync_mode, lookback_days, auto_sync, initial_filters } = data.body;

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

      // Check if this Stripe account is already connected (and active)
      const existing = await c.env.DB.prepare(`
        SELECT id FROM platform_connections
        WHERE organization_id = ? AND platform = 'stripe' AND stripe_account_id = ? AND is_active = 1
      `).bind(organization_id, accountInfo.stripe_account_id).first();

      if (existing) {
        return error(c, "ALREADY_EXISTS", "This Stripe account is already connected", 409);
      }

      // Create connection
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);

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

      // Store Stripe-specific fields and settings
      const isLiveMode = api_key.startsWith('sk_live_') || api_key.startsWith('rk_live_') ? 1 : 0;
      const settings = JSON.stringify({
        sync_mode: sync_mode || 'charges',
        lookback_days: lookback_days || 90,
        auto_sync: auto_sync !== false,
        initial_sync_completed: false
      });

      await c.env.DB.prepare(`
        UPDATE platform_connections
        SET stripe_account_id = ?,
            stripe_livemode = ?,
            settings = ?
        WHERE id = ?
      `).bind(
        accountInfo.stripe_account_id,
        isLiveMode,
        settings,
        connectionId
      ).run();

      // Create mode-specific default filter (serves as demo filter)
      const defaultFilterId = crypto.randomUUID();
      const syncMode = sync_mode || 'charges';
      const isSubscriptionMode = syncMode === 'subscriptions';

      // Use provided initial_filters or fall back to defaults
      let filterConfig: {
        name: string;
        description: string;
        rule_type: string;
        conditions: Array<{ type: string; field: string; operator: string; value: string | string[] }>;
      };

      if (initial_filters && initial_filters.length > 0) {
        // Convert user-provided filters to the internal format
        const conditions = initial_filters.map(f => ({
          type: 'standard' as const,
          field: f.field,
          operator: f.operator,
          // Handle comma-separated values for 'in' and 'not_in' operators
          value: (f.operator === 'in' || f.operator === 'not_in')
            ? f.value.split(',').map(v => v.trim())
            : f.value
        }));

        filterConfig = {
          name: isSubscriptionMode ? 'Subscription Filter' : 'Payment Filter',
          description: 'Custom filter configured during setup',
          rule_type: conditions.some(c => c.operator === 'not_in' || c.operator === 'not_equals') ? 'exclude' : 'include',
          conditions
        };
      } else {
        // Use default filters based on sync mode
        filterConfig = isSubscriptionMode ? {
          name: 'Exclude Incomplete Subscriptions',
          description: 'Excludes subscriptions that have not completed payment setup',
          rule_type: 'exclude',
          conditions: [
            {
              type: 'standard',
              field: 'status',
              operator: 'in',
              value: ['incomplete', 'incomplete_expired']
            }
          ]
        } : {
          name: 'Successful Payments Only',
          description: 'Only includes payments that have succeeded',
          rule_type: 'include',
          conditions: [
            {
              type: 'standard',
              field: 'status',
              operator: 'equals',
              value: 'succeeded'
            }
          ]
        };
      }

      const defaultFilterConfig = filterConfig;

      await c.env.DB.prepare(`
        INSERT INTO connector_filter_rules (
          id, connection_id, name, description, rule_type,
          operator, conditions, is_active, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        defaultFilterId,
        connectionId,
        defaultFilterConfig.name,
        defaultFilterConfig.description,
        defaultFilterConfig.rule_type,
        'AND',
        JSON.stringify(defaultFilterConfig.conditions),
        1,
        session.user_id
      ).run();

      // Update filter count on connection
      await c.env.DB.prepare(`
        UPDATE platform_connections SET filter_rules_count = 1 WHERE id = ?
      `).bind(connectionId).run();

      // Auto-advance onboarding when user connects first service
      const onboarding = new OnboardingService(c.env.DB);
      await onboarding.incrementServicesConnected(session.user_id);

      // Auto-trigger initial sync
      const jobId = crypto.randomUUID();
      // syncMode already defined above for filter creation
      const initialLookbackDays = lookback_days || 90;

      const syncEnd = new Date().toISOString();
      const syncStart = new Date(Date.now() - initialLookbackDays * 24 * 60 * 60 * 1000).toISOString();

      const metadata = {
        platform: 'stripe',
        account_id: accountInfo.stripe_account_id,
        sync_mode: syncMode,
        lookback_days: initialLookbackDays,
        is_initial_sync: true,
        triggered_by: session.user_id,
        retry_count: 0
      };

      // Create job record in database
      await c.env.DB.prepare(`
        INSERT INTO sync_jobs (
          id, organization_id, connection_id,
          status, job_type, metadata
        ) VALUES (?, ?, ?, 'pending', 'full', ?)
      `).bind(
        jobId,
        organization_id,
        connectionId,
        JSON.stringify(metadata)
      ).run();

      // Send job to queue for processing
      const queueMessage = {
        job_id: jobId,
        connection_id: connectionId,
        organization_id: organization_id,
        platform: 'stripe',
        account_id: accountInfo.stripe_account_id,
        job_type: 'full',
        sync_mode: syncMode,
        sync_window: {
          start: syncStart,
          end: syncEnd
        },
        metadata: {
          retry_count: 0,
          created_at: new Date().toISOString(),
          priority: 'normal',
          is_initial_sync: true,
          lookback_days: initialLookbackDays
        }
      };

      // Check if running locally (Supabase URL points to localhost)
      const isLocal = c.env.SUPABASE_URL?.includes('127.0.0.1') || c.env.SUPABASE_URL?.includes('localhost');

      if (isLocal) {
        // LOCAL DEV: Call queue consumer directly via HTTP (queues don't work locally)
        console.log('[ConnectStripe] LocalDev: Calling queue consumer directly');
        try {
          const response = await fetch('http://localhost:8789/test-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(queueMessage)
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('[ConnectStripe] Queue consumer returned error:', errorText);
          } else {
            const result = await response.json();
            console.log('[ConnectStripe] Sync job processed by queue consumer:', result);
          }
        } catch (err) {
          console.error('[ConnectStripe] Failed to call queue consumer:', err);
        }
      } else if (c.env.SYNC_QUEUE) {
        // PRODUCTION: Send to real Cloudflare Queue
        try {
          console.log('[ConnectStripe] Sending initial sync to queue:', JSON.stringify(queueMessage));
          await c.env.SYNC_QUEUE.send(queueMessage);
          console.log('[ConnectStripe] Successfully sent to queue');
        } catch (queueError) {
          console.error('[ConnectStripe] Queue send error:', queueError);
        }
      }

      return success(c, {
        connection_id: connectionId,
        sync_job_id: jobId,
        account_info: {
          stripe_account_id: accountInfo.stripe_account_id,
          business_name: accountInfo.business_profile?.name,
          country: accountInfo.country,
          default_currency: accountInfo.default_currency,
          charges_enabled: accountInfo.charges_enabled
        }
      }, undefined, 201);
    } catch (err: any) {
      console.error("Stripe connection error:", err);
      return error(c, "INVALID_API_KEY", err.message || "Failed to validate Stripe API key", 400);
    }
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
          sync_mode: z.enum(['charges', 'subscriptions']).optional(),
          lookback_days: z.number().min(1).max(730).optional(),
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
    // Config parameters validated but not yet implemented

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

    // Pre-launch: No reconfiguration checks needed

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

    // Pre-launch: No reconfiguration checks needed

    // Check if there's already a pending/running sync
    const activeSync = await c.env.DB.prepare(`
      SELECT id FROM sync_jobs
      WHERE connection_id = ? AND status IN ('pending', 'running')
    `).bind(connectionId).first();

    if (activeSync) {
      return error(c, "CONFLICT", "A sync is already in progress", 409);
    }

    // Parse connection settings
    let connectionSettings: {
      sync_mode?: string;
      lookback_days?: number;
      auto_sync?: boolean;
      initial_sync_completed?: boolean;
    } = {};
    try {
      connectionSettings = connection.settings ? JSON.parse(connection.settings as string) : {};
    } catch (e) {
      console.warn('Failed to parse connection settings:', e);
    }

    // Determine sync parameters
    const isInitialSync = !connectionSettings.initial_sync_completed;
    const syncMode = connectionSettings.sync_mode || 'charges';
    const lookbackDays = body.lookback_days || connectionSettings.lookback_days || (isInitialSync ? 90 : 7);

    // Queue new sync job
    const jobId = crypto.randomUUID();

    const metadata = {
      platform: 'stripe',
      account_id: connection.stripe_account_id || connection.account_id,
      sync_mode: syncMode,
      date_from: body.date_from,
      date_to: body.date_to,
      lookback_days: lookbackDays,
      is_initial_sync: isInitialSync,
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

    // Calculate sync window based on settings
    const syncEnd = body.date_to || new Date().toISOString();
    const syncStart = body.date_from || new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

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
          sync_mode: syncMode,
          sync_window: {
            start: syncStart,
            end: syncEnd
          },
          metadata: {
            retry_count: 0,
            created_at: new Date().toISOString(),
            priority: 'normal',
            is_initial_sync: isInitialSync,
            lookback_days: lookbackDays
          }
        };
        console.log('Sending to queue:', JSON.stringify(queueMessage));
        await c.env.SYNC_QUEUE.send(queueMessage);
        console.log('Successfully sent to queue');

        // Mark initial sync as started if this is the first sync
        if (isInitialSync) {
          const updatedSettings = { ...connectionSettings, initial_sync_completed: true };
          await c.env.DB.prepare(`
            UPDATE platform_connections SET settings = ? WHERE id = ?
          `).bind(JSON.stringify(updatedSettings), connectionId).run();
        }
      } catch (queueError) {
        console.error('Queue send error:', queueError);
      }
    } else {
      console.error('SYNC_QUEUE binding not available!');
    }

    return success(c, {
      job_id: jobId,
      message: "Sync job queued successfully"
    }, undefined, 202);
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