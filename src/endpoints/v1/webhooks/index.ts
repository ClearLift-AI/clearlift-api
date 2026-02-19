/**
 * Webhook Endpoints
 *
 * Handles incoming webhooks from external platforms like Stripe, Shopify, HubSpot.
 *
 * Flow:
 * 1. Receive webhook POST request
 * 2. Verify signature using platform-specific handler
 * 3. Parse event and check for duplicates
 * 4. Store event and queue for processing
 * 5. Return 200 OK immediately (async processing)
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { getSecret } from "../../../utils/secrets";
import { getWebhookHandler, getSupportedConnectors } from "./handlers";
import { structuredLog } from "../../../utils/structured-logger";

// =============================================================================
// Receive Webhook Event
// =============================================================================

export class ReceiveWebhook extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks"],
    summary: "Receive webhook event from external platform",
    operationId: "webhook-receive",
    request: {
      params: z.object({
        connector: z.string().describe("Platform connector (stripe, shopify, hubspot)"),
      }),
    },
    responses: {
      "200": {
        description: "Webhook received successfully",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                received: z.boolean(),
                event_id: z.string().nullable(),
              }),
            }),
          },
        },
      },
      "400": {
        description: "Invalid webhook payload or signature",
      },
      "404": {
        description: "Unknown connector or endpoint not configured",
      },
    },
  };

  public async handle(c: AppContext) {
    const { connector } = c.req.param() as { connector: string };

    // Get the handler for this connector
    const handler = getWebhookHandler(connector);
    if (!handler) {
      return error(c, "UNKNOWN_CONNECTOR", `Unsupported connector: ${connector}`, 404);
    }

    // Get raw body for signature verification
    const body = await c.req.text();
    if (!body) {
      return error(c, "EMPTY_BODY", "Webhook body is empty", 400);
    }

    // Get organization from query param or reverse-lookup from platform headers
    let orgId = c.req.query("org_id");

    // Shopify: look up org from X-Shopify-Shop-Domain header when org_id is missing
    if (!orgId && connector === "shopify") {
      const shopDomain = c.req.raw.headers.get("X-Shopify-Shop-Domain");
      if (shopDomain) {
        const org = await getOrgByShopDomain(c.env.DB, shopDomain);
        if (org) {
          orgId = org.organization_id;
          console.log(`[Webhook] Resolved org ${orgId} from shop domain ${shopDomain}`);
        } else {
          structuredLog('WARN', 'No org found for shop domain', { endpoint: 'webhooks', connector: 'shopify', shop_domain: shopDomain });
          return error(c, "UNKNOWN_SHOP", `No connection found for shop: ${shopDomain}`, 404);
        }
      }
    }

    if (!orgId) {
      return error(c, "MISSING_ORG", "Organization ID required (pass ?org_id= or use platform-specific headers)", 400);
    }

    // Look up the webhook endpoint for this org/connector
    const endpoint = await c.env.DB.prepare(
      `SELECT id, endpoint_secret, is_active, events_subscribed
       FROM webhook_endpoints
       WHERE organization_id = ? AND connector = ?`
    )
      .bind(orgId, connector)
      .first<{
        id: string;
        endpoint_secret: string;
        is_active: number;
        events_subscribed: string | null;
      }>();

    // For Shopify with TOML-declared webhooks, endpoint row may not exist yet.
    // Use the app-level SHOPIFY_CLIENT_SECRET for HMAC verification instead.
    if (!endpoint && connector === "shopify") {
      const appSecret = await getSecret(c.env.SHOPIFY_CLIENT_SECRET);
      if (!appSecret) {
        return error(c, "CONFIG_ERROR", "Shopify webhook secret not configured", 500);
      }

      // Verify HMAC with app-level secret
      const isValid = await handler.verifySignature(c.req.raw.headers, body, appSecret);
      if (!isValid) {
        structuredLog('WARN', 'Shopify HMAC verification failed', { endpoint: 'webhooks', connector: 'shopify', org_id: orgId });
        return error(c, "INVALID_SIGNATURE", "Webhook signature verification failed", 400);
      }

      // Parse and process the event (skip endpoint-based filtering)
      let event;
      try {
        event = handler.parseEvent(body);
      } catch (e) {
        return error(c, "INVALID_PAYLOAD", "Failed to parse webhook payload", 400);
      }

      const eventType = handler.getEventType(event);
      const eventId = handler.getEventId(event);
      const unifiedEventType = handler.getUnifiedEventType(event);

      // Dedup check (webhook_events in ANALYTICS_DB)
      if (eventId) {
        const existing = await c.env.ANALYTICS_DB.prepare(
          `SELECT id FROM webhook_events WHERE organization_id = ? AND connector = ? AND event_id = ?`
        ).bind(orgId, connector, eventId).first();
        if (existing) {
          return success(c, { received: true, event_id: eventId, duplicate: true });
        }
      }

      const webhookEventId = crypto.randomUUID();
      const payloadHash = await hashPayload(body);

      await c.env.ANALYTICS_DB.prepare(
        `INSERT INTO webhook_events
         (id, organization_id, endpoint_id, connector, event_type, unified_event_type, event_id, payload_hash, payload, status, received_at)
         VALUES (?, ?, 'shopify_app', ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
      ).bind(webhookEventId, orgId, connector, eventType, unifiedEventType, eventId, payloadHash, body).run();

      // Queue for processing
      if (c.env.SYNC_QUEUE) {
        try {
          await c.env.SYNC_QUEUE.send({
            type: "webhook_event",
            organization_id: orgId,
            connector,
            event_type: eventType,
            unified_event_type: unifiedEventType,
            webhook_event_id: webhookEventId,
          });
        } catch (queueError) {
          const errMsg = queueError instanceof Error ? queueError.message : String(queueError);
          structuredLog('ERROR', 'Queue send failed', {
            endpoint: 'webhooks',
            connector,
            event_type: eventType,
            webhook_event_id: webhookEventId,
            org_id: orgId,
            error: errMsg,
          });

          // Mark the stored event as queue_failed so a sweep job can retry it
          try {
            await c.env.ANALYTICS_DB.prepare(
              `UPDATE webhook_events SET status = 'queue_failed', error_message = ? WHERE id = ?`
            ).bind(`Queue send failed: ${errMsg}`, webhookEventId).run();
          } catch (d1Error) {
            structuredLog('CRITICAL', 'Queue send AND D1 status update both failed', {
              endpoint: 'webhooks',
              connector,
              event_type: eventType,
              webhook_event_id: webhookEventId,
              org_id: orgId,
              queue_error: errMsg,
              d1_error: d1Error instanceof Error ? d1Error.message : String(d1Error),
            });
          }
        }
      }

      return success(c, { received: true, event_id: eventId });
    }

    if (!endpoint) {
      return error(c, "ENDPOINT_NOT_FOUND", "Webhook endpoint not configured", 404);
    }

    if (!endpoint.is_active) {
      return error(c, "ENDPOINT_DISABLED", "Webhook endpoint is disabled", 400);
    }

    // Verify signature
    const isValid = await handler.verifySignature(
      c.req.raw.headers,
      body,
      endpoint.endpoint_secret
    );

    if (!isValid) {
      // Log failed verification for security monitoring
      structuredLog('WARN', 'Signature verification failed', { endpoint: 'webhooks', connector, org_id: orgId });
      return error(c, "INVALID_SIGNATURE", "Webhook signature verification failed", 400);
    }

    // Parse the event
    let event;
    try {
      event = handler.parseEvent(body);
    } catch (e) {
      return error(c, "INVALID_PAYLOAD", "Failed to parse webhook payload", 400);
    }

    const eventType = handler.getEventType(event);
    const eventId = handler.getEventId(event);
    const unifiedEventType = handler.getUnifiedEventType(event);

    // Check if this event type is subscribed (if filtering is configured)
    if (endpoint.events_subscribed) {
      const subscribed = JSON.parse(endpoint.events_subscribed) as string[];
      if (subscribed.length > 0 && !subscribed.includes(eventType)) {
        // Event type not subscribed, acknowledge but skip processing
        return success(c, { received: true, event_id: eventId, skipped: true });
      }
    }

    // Check for duplicate events (webhook_events in ANALYTICS_DB)
    if (eventId) {
      const existing = await c.env.ANALYTICS_DB.prepare(
        `SELECT id FROM webhook_events
         WHERE organization_id = ? AND connector = ? AND event_id = ?`
      )
        .bind(orgId, connector, eventId)
        .first();

      if (existing) {
        // Duplicate event, acknowledge but skip
        return success(c, { received: true, event_id: eventId, duplicate: true });
      }
    }

    // Generate IDs
    const webhookEventId = crypto.randomUUID();
    const payloadHash = await hashPayload(body);

    // Store the event (webhook_events in ANALYTICS_DB)
    await c.env.ANALYTICS_DB.prepare(
      `INSERT INTO webhook_events
       (id, organization_id, endpoint_id, connector, event_type, unified_event_type, event_id, payload_hash, payload, status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
    )
      .bind(
        webhookEventId,
        orgId,
        endpoint.id,
        connector,
        eventType,
        unifiedEventType,
        eventId,
        payloadHash,
        body
      )
      .run();

    // Update endpoint stats
    await c.env.DB.prepare(
      `UPDATE webhook_endpoints
       SET receive_count = receive_count + 1, last_received_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(endpoint.id)
      .run();

    // Queue for processing (if queue is available)
    if (c.env.SYNC_QUEUE) {
      try {
        await c.env.SYNC_QUEUE.send({
          type: "webhook_event",
          organization_id: orgId,
          connector,
          event_type: eventType,
          unified_event_type: unifiedEventType,
          webhook_event_id: webhookEventId,
        });
      } catch (queueError) {
        const errMsg = queueError instanceof Error ? queueError.message : String(queueError);
        structuredLog('ERROR', 'Queue send failed', {
          endpoint: 'webhooks',
          connector,
          event_type: eventType,
          webhook_event_id: webhookEventId,
          org_id: orgId,
          error: errMsg,
        });

        // Mark the stored event as queue_failed so a sweep job can retry it
        try {
          await c.env.ANALYTICS_DB.prepare(
            `UPDATE webhook_events SET status = 'queue_failed', error_message = ? WHERE id = ?`
          ).bind(`Queue send failed: ${errMsg}`, webhookEventId).run();
        } catch (d1Error) {
          structuredLog('CRITICAL', 'Queue send AND D1 status update both failed', {
            endpoint: 'webhooks',
            connector,
            event_type: eventType,
            webhook_event_id: webhookEventId,
            org_id: orgId,
            queue_error: errMsg,
            d1_error: d1Error instanceof Error ? d1Error.message : String(d1Error),
          });
        }
      }
    }

    return success(c, { received: true, event_id: eventId });
  }
}

// =============================================================================
// List Webhook Endpoints
// =============================================================================

export class ListWebhookEndpoints extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks"],
    summary: "List configured webhook endpoints for organization",
    operationId: "webhook-list",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
    },
    responses: {
      "200": {
        description: "List of webhook endpoints",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(
                z.object({
                  id: z.string(),
                  connector: z.string(),
                  is_active: z.boolean(),
                  events_subscribed: z.array(z.string()).nullable(),
                  receive_count: z.number(),
                  error_count: z.number(),
                  last_received_at: z.string().nullable(),
                  created_at: z.string(),
                })
              ),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");

    const endpoints = await c.env.DB.prepare(
      `SELECT id, connector, is_active, events_subscribed, receive_count, error_count, last_received_at, created_at
       FROM webhook_endpoints
       WHERE organization_id = ?
       ORDER BY created_at DESC`
    )
      .bind(orgId)
      .all();

    const data = (endpoints.results || []).map((row: any) => ({
      id: row.id,
      connector: row.connector,
      is_active: !!row.is_active,
      events_subscribed: row.events_subscribed
        ? JSON.parse(row.events_subscribed)
        : null,
      receive_count: row.receive_count || 0,
      error_count: row.error_count || 0,
      last_received_at: row.last_received_at,
      created_at: row.created_at,
    }));

    return success(c, data);
  }
}

// =============================================================================
// Create Webhook Endpoint
// =============================================================================

export class CreateWebhookEndpoint extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks"],
    summary: "Create a webhook endpoint for a connector",
    operationId: "webhook-create",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              connector: z.string().describe("Platform connector"),
              events_subscribed: z
                .array(z.string())
                .optional()
                .describe("Event types to subscribe to (null = all)"),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Webhook endpoint created",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                id: z.string(),
                connector: z.string(),
                webhook_url: z.string(),
                endpoint_secret: z.string().describe("Secret for signature verification"),
              }),
            }),
          },
        },
      },
      "400": {
        description: "Endpoint already exists for this connector",
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");
    const body = await c.req.json();
    const { connector, events_subscribed } = body;

    // Validate connector is supported
    if (!getSupportedConnectors().includes(connector)) {
      return error(
        c,
        "UNSUPPORTED_CONNECTOR",
        `Connector ${connector} is not supported for webhooks. Supported: ${getSupportedConnectors().join(", ")}`,
        400
      );
    }

    // Check if endpoint already exists
    const existing = await c.env.DB.prepare(
      `SELECT id FROM webhook_endpoints WHERE organization_id = ? AND connector = ?`
    )
      .bind(orgId, connector)
      .first();

    if (existing) {
      return error(c, "ENDPOINT_EXISTS", "Webhook endpoint already exists for this connector", 400);
    }

    // Generate endpoint ID and secret
    const endpointId = crypto.randomUUID();
    const endpointSecret = generateWebhookSecret();

    // Create the endpoint
    await c.env.DB.prepare(
      `INSERT INTO webhook_endpoints
       (id, organization_id, connector, endpoint_secret, is_active, events_subscribed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`
    )
      .bind(
        endpointId,
        orgId,
        connector,
        endpointSecret,
        events_subscribed ? JSON.stringify(events_subscribed) : null
      )
      .run();

    // Build webhook URL
    const baseUrl = c.env.OAUTH_CALLBACK_BASE || "https://api.adbliss.io";
    const webhookUrl = `${baseUrl}/v1/webhooks/${connector}?org_id=${orgId}`;

    return success(c, {
      id: endpointId,
      connector,
      webhook_url: webhookUrl,
      endpoint_secret: endpointSecret,
    });
  }
}

// =============================================================================
// Delete Webhook Endpoint
// =============================================================================

export class DeleteWebhookEndpoint extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks"],
    summary: "Delete a webhook endpoint",
    operationId: "webhook-delete",
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
        description: "Webhook endpoint deleted",
      },
      "404": {
        description: "Endpoint not found",
      },
    },
  };

  public async handle(c: AppContext) {
    const { id } = c.req.param() as { id: string };
    const orgId = c.req.query("org_id");

    const result = await c.env.DB.prepare(
      `DELETE FROM webhook_endpoints WHERE id = ? AND organization_id = ?`
    )
      .bind(id, orgId)
      .run();

    if (!result.meta.changes) {
      return error(c, "NOT_FOUND", "Webhook endpoint not found", 404);
    }

    return success(c, { deleted: true });
  }
}

// =============================================================================
// Get Webhook Events
// =============================================================================

export class GetWebhookEvents extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks"],
    summary: "List webhook events for an endpoint",
    operationId: "webhook-events",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string(),
        endpoint_id: z.string().optional(),
        status: z.enum(["pending", "processing", "completed", "failed", "skipped"]).optional(),
        limit: z.coerce.number().default(50),
        offset: z.coerce.number().default(0),
      }),
    },
    responses: {
      "200": {
        description: "List of webhook events",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.array(
                z.object({
                  id: z.string(),
                  connector: z.string(),
                  event_type: z.string(),
                  event_id: z.string().nullable(),
                  status: z.string(),
                  attempts: z.number(),
                  error_message: z.string().nullable(),
                  received_at: z.string(),
                  processed_at: z.string().nullable(),
                })
              ),
              meta: z.object({
                total: z.number(),
                limit: z.number(),
                offset: z.number(),
              }),
            }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const orgId = c.req.query("org_id");
    const endpointId = c.req.query("endpoint_id");
    const status = c.req.query("status");
    const limit = parseInt(c.req.query("limit") || "50", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let query = `SELECT id, connector, event_type, event_id, status, attempts, error_message, received_at, processed_at
                 FROM webhook_events
                 WHERE organization_id = ?`;
    const params: (string | number)[] = [orgId!];

    if (endpointId) {
      query += " AND endpoint_id = ?";
      params.push(endpointId);
    }

    if (status) {
      query += " AND status = ?";
      params.push(status);
    }

    query += " ORDER BY received_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const events = await c.env.ANALYTICS_DB.prepare(query).bind(...params).all();

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM webhook_events WHERE organization_id = ?`;
    const countParams: (string | number)[] = [orgId!];

    if (endpointId) {
      countQuery += " AND endpoint_id = ?";
      countParams.push(endpointId);
    }

    if (status) {
      countQuery += " AND status = ?";
      countParams.push(status);
    }

    const countResult = await c.env.ANALYTICS_DB.prepare(countQuery)
      .bind(...countParams)
      .first<{ total: number }>();

    return success(
      c,
      events.results || [],
      { total: countResult?.total || 0, limit, offset }
    );
  }
}

// =============================================================================
// Helpers
// =============================================================================

function generateWebhookSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return "whsec_" + Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPayload(payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// =============================================================================
// Shopify GDPR Compliance Helpers
// =============================================================================

/**
 * Verify Shopify webhook HMAC signature.
 * Used by GDPR endpoints which bypass the generic ReceiveWebhook flow.
 */
async function verifyShopifyHmac(
  headers: Headers,
  body: string,
  secret: string
): Promise<boolean> {
  const signature = headers.get("X-Shopify-Hmac-Sha256");
  if (!signature) return false;

  try {
    const expectedSignature = createHmac("sha256", secret)
      .update(body, "utf8")
      .digest("base64");

    const sigBuffer = Buffer.from(signature, "base64");
    const expectedBuffer = Buffer.from(expectedSignature, "base64");

    return sigBuffer.length === expectedBuffer.length &&
      timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Look up organization by Shopify shop domain from platform_connections.
 */
async function getOrgByShopDomain(
  db: D1Database,
  shopDomain: string
): Promise<{ organization_id: string; connection_id: string } | null> {
  const row = await db.prepare(
    `SELECT id, organization_id FROM platform_connections
     WHERE platform = 'shopify' AND LOWER(account_id) = LOWER(?) AND is_active = 1
     LIMIT 1`
  )
    .bind(shopDomain)
    .first<{ id: string; organization_id: string }>();

  if (!row) return null;
  return { organization_id: row.organization_id, connection_id: row.id };
}

// =============================================================================
// Shopify GDPR: Customer Data Request
// =============================================================================

/**
 * Shopify mandatory GDPR webhook: customers/data_request
 *
 * When a customer requests their data from a store, Shopify sends this webhook.
 * We must respond with 200 and process the request asynchronously.
 */
export class ShopifyCustomerDataRequest extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks", "GDPR"],
    summary: "Shopify GDPR: Customer data request",
    operationId: "shopify-gdpr-customer-data-request",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              shop_id: z.number(),
              shop_domain: z.string(),
              customer: z.object({
                id: z.number(),
                email: z.string(),
                phone: z.string().nullable().optional(),
              }),
              orders_requested: z.array(z.number()),
              data_request: z.object({ id: z.number() }),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Data request acknowledged",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const body = await c.req.text();

    // Verify HMAC — mandatory for all Shopify webhooks
    const secret = await getSecret(c.env.SHOPIFY_CLIENT_SECRET);
    if (!secret) {
      structuredLog('ERROR', 'SHOPIFY_CLIENT_SECRET not configured', { endpoint: 'webhooks', step: 'gdpr_customer_data_request' });
      return error(c, "CONFIG_ERROR", "Webhook secret not configured", 500);
    }

    const isValid = await verifyShopifyHmac(c.req.raw.headers, body, secret);
    if (!isValid) {
      structuredLog('WARN', 'GDPR customers/data_request HMAC verification failed', { endpoint: 'webhooks', step: 'gdpr_customer_data_request' });
      return error(c, "INVALID_SIGNATURE", "HMAC verification failed", 401);
    }

    const payload = JSON.parse(body);
    const { shop_domain, customer, orders_requested, data_request } = payload;

    console.log(
      `[GDPR] Customer data request: shop=${shop_domain} customer_id=${customer.id} request_id=${data_request.id} orders=${orders_requested.length}`
    );

    // Look up org for audit trail
    const org = await getOrgByShopDomain(c.env.DB, shop_domain);

    // Log the GDPR request for compliance audit (webhook_events in ANALYTICS_DB)
    await c.env.ANALYTICS_DB.prepare(
      `INSERT INTO webhook_events
       (id, organization_id, endpoint_id, connector, event_type, unified_event_type, event_id, payload_hash, payload, status, received_at)
       VALUES (?, ?, 'gdpr', 'shopify', 'customers/data_request', 'gdpr.customers_data_request', ?, ?, ?, 'pending', datetime('now'))`
    )
      .bind(
        crypto.randomUUID(),
        org?.organization_id || `shop:${shop_domain}`,
        `data_request_${data_request.id}`,
        await hashPayload(body),
        body
      )
      .run();

    // ClearLift stores minimal PII (only email hashes, not raw emails).
    // The actual data package would be assembled asynchronously if needed.
    // For now, acknowledge receipt — Shopify requires 200 within 5 seconds.

    return success(c, { received: true });
  }
}

// =============================================================================
// Shopify GDPR: Customer Redact
// =============================================================================

/**
 * Shopify mandatory GDPR webhook: customers/redact
 *
 * When a store owner requests deletion of a customer's data, Shopify sends this.
 * We must delete all PII associated with this customer.
 */
export class ShopifyCustomerRedact extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks", "GDPR"],
    summary: "Shopify GDPR: Customer data redaction",
    operationId: "shopify-gdpr-customer-redact",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              shop_id: z.number(),
              shop_domain: z.string(),
              customer: z.object({
                id: z.number(),
                email: z.string(),
                phone: z.string().nullable().optional(),
              }),
              orders_to_redact: z.array(z.number()),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Redaction acknowledged",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const body = await c.req.text();

    const secret = await getSecret(c.env.SHOPIFY_CLIENT_SECRET);
    if (!secret) {
      structuredLog('ERROR', 'SHOPIFY_CLIENT_SECRET not configured', { endpoint: 'webhooks', step: 'gdpr_customer_redact' });
      return error(c, "CONFIG_ERROR", "Webhook secret not configured", 500);
    }

    const isValid = await verifyShopifyHmac(c.req.raw.headers, body, secret);
    if (!isValid) {
      structuredLog('WARN', 'GDPR customers/redact HMAC verification failed', { endpoint: 'webhooks', step: 'gdpr_customer_redact' });
      return error(c, "INVALID_SIGNATURE", "HMAC verification failed", 401);
    }

    const payload = JSON.parse(body);
    const { shop_domain, customer, orders_to_redact } = payload;
    const shopifyCustomerId = String(customer.id);

    console.log(
      `[GDPR] Customer redact: shop=${shop_domain} customer_id=${shopifyCustomerId} orders=${orders_to_redact.length}`
    );

    const org = await getOrgByShopDomain(c.env.DB, shop_domain);

    // Log for compliance audit (webhook_events in ANALYTICS_DB)
    await c.env.ANALYTICS_DB.prepare(
      `INSERT INTO webhook_events
       (id, organization_id, endpoint_id, connector, event_type, unified_event_type, event_id, payload_hash, payload, status, received_at)
       VALUES (?, ?, 'gdpr', 'shopify', 'customers/redact', 'gdpr.customers_redact', ?, ?, ?, 'processing', datetime('now'))`
    )
      .bind(
        crypto.randomUUID(),
        org?.organization_id || `shop:${shop_domain}`,
        `redact_customer_${shopifyCustomerId}`,
        await hashPayload(body),
        body
      )
      .run();

    if (org) {
      // Redact customer PII from all tables
      const statements = [];

      // 1. Null out email hashes in shopify_orders (ANALYTICS_DB)
      statements.push(
        c.env.ANALYTICS_DB.prepare(
          `UPDATE shopify_orders SET customer_email_hash = NULL
           WHERE organization_id = ? AND customer_id = ?`
        ).bind(org.organization_id, shopifyCustomerId)
      );

      // 2. Null out customer data in ecommerce_orders (ANALYTICS_DB)
      statements.push(
        c.env.ANALYTICS_DB.prepare(
          `UPDATE ecommerce_orders SET customer_email_hash = NULL, customer_external_id = NULL
           WHERE organization_id = ? AND platform = 'shopify' AND customer_external_id = ?`
        ).bind(org.organization_id, shopifyCustomerId)
      );

      // 3. Null out customer data in ecommerce_customers (ANALYTICS_DB)
      statements.push(
        c.env.ANALYTICS_DB.prepare(
          `UPDATE ecommerce_customers SET email_hash = NULL, name = NULL, phone_hash = NULL
           WHERE organization_id = ? AND platform = 'shopify' AND external_id = ?`
        ).bind(org.organization_id, shopifyCustomerId)
      );

      // 4. Remove from customer_identities (ANALYTICS_DB)
      statements.push(
        c.env.ANALYTICS_DB.prepare(
          `DELETE FROM customer_identities
           WHERE organization_id = ? AND source_platform = 'shopify' AND source_id = ?`
        ).bind(org.organization_id, shopifyCustomerId)
      );

      try {
        await c.env.ANALYTICS_DB.batch(statements);
        console.log(`[GDPR] Redacted customer ${shopifyCustomerId} for org ${org.organization_id}`);
      } catch (err) {
        structuredLog('ERROR', `Redaction DB error for customer ${shopifyCustomerId}`, { endpoint: 'webhooks', step: 'gdpr_customer_redact', customer_id: shopifyCustomerId, error: err instanceof Error ? err.message : String(err) });
        // Still return 200 — we've logged the request and will retry
      }
    }

    return success(c, { received: true });
  }
}

// =============================================================================
// Shopify GDPR: Shop Redact
// =============================================================================

/**
 * Shopify mandatory GDPR webhook: shop/redact
 *
 * Sent 48 hours after a store uninstalls the app.
 * We must delete all data associated with this shop.
 */
export class ShopifyShopRedact extends OpenAPIRoute {
  public schema = {
    tags: ["Webhooks", "GDPR"],
    summary: "Shopify GDPR: Shop data redaction",
    operationId: "shopify-gdpr-shop-redact",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              shop_id: z.number(),
              shop_domain: z.string(),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Shop redaction acknowledged",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
          },
        },
      },
    },
  };

  public async handle(c: AppContext) {
    const body = await c.req.text();

    const secret = await getSecret(c.env.SHOPIFY_CLIENT_SECRET);
    if (!secret) {
      structuredLog('ERROR', 'SHOPIFY_CLIENT_SECRET not configured', { endpoint: 'webhooks', step: 'gdpr_shop_redact' });
      return error(c, "CONFIG_ERROR", "Webhook secret not configured", 500);
    }

    const isValid = await verifyShopifyHmac(c.req.raw.headers, body, secret);
    if (!isValid) {
      structuredLog('WARN', 'GDPR shop/redact HMAC verification failed', { endpoint: 'webhooks', step: 'gdpr_shop_redact' });
      return error(c, "INVALID_SIGNATURE", "HMAC verification failed", 401);
    }

    const payload = JSON.parse(body);
    const { shop_id, shop_domain } = payload;

    console.log(`[GDPR] Shop redact: shop=${shop_domain} shop_id=${shop_id}`);

    const org = await getOrgByShopDomain(c.env.DB, shop_domain);

    // Log for compliance audit (webhook_events in ANALYTICS_DB)
    await c.env.ANALYTICS_DB.prepare(
      `INSERT INTO webhook_events
       (id, organization_id, endpoint_id, connector, event_type, unified_event_type, event_id, payload_hash, payload, status, received_at)
       VALUES (?, ?, 'gdpr', 'shopify', 'shop/redact', 'gdpr.shop_redact', ?, ?, ?, 'processing', datetime('now'))`
    )
      .bind(
        crypto.randomUUID(),
        org?.organization_id || `shop:${shop_domain}`,
        `redact_shop_${shop_id}`,
        await hashPayload(body),
        body
      )
      .run();

    if (org) {
      try {
        // Delete all Shopify data for this organization
        const analyticsStatements = [
          c.env.ANALYTICS_DB.prepare(
            `DELETE FROM shopify_orders WHERE organization_id = ?`
          ).bind(org.organization_id),
          c.env.ANALYTICS_DB.prepare(
            `DELETE FROM shopify_refunds WHERE organization_id = ?`
          ).bind(org.organization_id),
          c.env.ANALYTICS_DB.prepare(
            `DELETE FROM ecommerce_orders WHERE organization_id = ? AND platform = 'shopify'`
          ).bind(org.organization_id),
          c.env.ANALYTICS_DB.prepare(
            `DELETE FROM ecommerce_customers WHERE organization_id = ? AND platform = 'shopify'`
          ).bind(org.organization_id),
          c.env.ANALYTICS_DB.prepare(
            `DELETE FROM ecommerce_products WHERE organization_id = ? AND platform = 'shopify'`
          ).bind(org.organization_id),
          c.env.ANALYTICS_DB.prepare(
            `DELETE FROM customer_identities WHERE organization_id = ? AND source_platform = 'shopify'`
          ).bind(org.organization_id),
        ];
        await c.env.ANALYTICS_DB.batch(analyticsStatements);

        // Deactivate the platform connection (don't delete — keep for audit trail)
        await c.env.DB.prepare(
          `UPDATE platform_connections SET is_active = 0, sync_status = 'disabled', sync_error = 'Shop redacted via GDPR webhook'
           WHERE organization_id = ? AND platform = 'shopify'`
        ).bind(org.organization_id).run();

        console.log(`[GDPR] Redacted all Shopify data for org ${org.organization_id}`);
      } catch (err) {
        structuredLog('ERROR', `Shop redaction DB error for ${shop_domain}`, { endpoint: 'webhooks', step: 'gdpr_shop_redact', shop_domain, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return success(c, { received: true });
  }
}
