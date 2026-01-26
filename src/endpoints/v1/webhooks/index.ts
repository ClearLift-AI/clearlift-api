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
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { getWebhookHandler, getSupportedConnectors } from "./handlers";

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

    // Get organization from webhook path or lookup
    // Webhooks use a URL pattern like /v1/webhooks/:connector/:org_id
    // or we can lookup by connector + some identifier in the payload
    const orgId = c.req.query("org_id");

    if (!orgId) {
      // Try to find org from endpoint registration
      // For now, require org_id in query string
      return error(c, "MISSING_ORG", "Organization ID required", 400);
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
      console.warn(`[Webhook] Signature verification failed for ${connector}/${orgId}`);
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

    // Check if this event type is subscribed (if filtering is configured)
    if (endpoint.events_subscribed) {
      const subscribed = JSON.parse(endpoint.events_subscribed) as string[];
      if (subscribed.length > 0 && !subscribed.includes(eventType)) {
        // Event type not subscribed, acknowledge but skip processing
        return success(c, { received: true, event_id: eventId, skipped: true });
      }
    }

    // Check for duplicate events
    if (eventId) {
      const existing = await c.env.DB.prepare(
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

    // Store the event
    await c.env.DB.prepare(
      `INSERT INTO webhook_events
       (id, organization_id, endpoint_id, connector, event_type, event_id, payload_hash, payload, status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
    )
      .bind(
        webhookEventId,
        orgId,
        endpoint.id,
        connector,
        eventType,
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
          webhook_event_id: webhookEventId,
        });
      } catch (queueError) {
        console.error("[Webhook] Failed to queue event:", queueError);
        // Event is stored, can be retried later
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
    const baseUrl = "https://api.clearlift.ai";
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

    const events = await c.env.DB.prepare(query).bind(...params).all();

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

    const countResult = await c.env.DB.prepare(countQuery)
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
