/**
 * Webhook Handlers
 *
 * Platform-specific webhook signature verification and event parsing.
 * Each handler implements the WebhookHandler interface.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

export interface WebhookEvent {
  id: string | null;
  type: string;
  payload: unknown;
  timestamp?: string;
}

export interface WebhookHandler {
  connector: string;
  verifySignature(
    headers: Headers,
    body: string,
    secret: string
  ): Promise<boolean>;
  parseEvent(body: string): WebhookEvent;
  getEventType(event: WebhookEvent): string;
  getEventId(event: WebhookEvent): string | null;
}

// =============================================================================
// Stripe Webhook Handler
// =============================================================================

export class StripeWebhookHandler implements WebhookHandler {
  connector = "stripe";

  async verifySignature(
    headers: Headers,
    body: string,
    secret: string
  ): Promise<boolean> {
    const signature = headers.get("Stripe-Signature");
    if (!signature) return false;

    try {
      // Parse signature header
      const elements = signature.split(",");
      const signatureParts: Record<string, string> = {};

      for (const element of elements) {
        const [key, value] = element.split("=");
        signatureParts[key] = value;
      }

      const timestamp = signatureParts["t"];
      const v1Signature = signatureParts["v1"];

      if (!timestamp || !v1Signature) return false;

      // Check timestamp (reject if older than 5 minutes)
      const timestampAge = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
      if (timestampAge > 300) return false;

      // Compute expected signature
      const signedPayload = `${timestamp}.${body}`;
      const expectedSignature = createHmac("sha256", secret)
        .update(signedPayload)
        .digest("hex");

      // Constant-time comparison
      const sigBuffer = Buffer.from(v1Signature, "hex");
      const expectedBuffer = Buffer.from(expectedSignature, "hex");

      return sigBuffer.length === expectedBuffer.length &&
        timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  parseEvent(body: string): WebhookEvent {
    const data = JSON.parse(body);
    return {
      id: data.id || null,
      type: data.type || "unknown",
      payload: data,
      timestamp: data.created
        ? new Date(data.created * 1000).toISOString()
        : undefined,
    };
  }

  getEventType(event: WebhookEvent): string {
    return event.type;
  }

  getEventId(event: WebhookEvent): string | null {
    return event.id;
  }
}

// =============================================================================
// Shopify Webhook Handler
// =============================================================================

export class ShopifyWebhookHandler implements WebhookHandler {
  connector = "shopify";

  async verifySignature(
    headers: Headers,
    body: string,
    secret: string
  ): Promise<boolean> {
    const signature = headers.get("X-Shopify-Hmac-Sha256");
    if (!signature) return false;

    try {
      // Compute expected HMAC
      const expectedSignature = createHmac("sha256", secret)
        .update(body, "utf8")
        .digest("base64");

      // Constant-time comparison
      const sigBuffer = Buffer.from(signature, "base64");
      const expectedBuffer = Buffer.from(expectedSignature, "base64");

      return sigBuffer.length === expectedBuffer.length &&
        timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  parseEvent(body: string): WebhookEvent {
    const data = JSON.parse(body);
    return {
      id: data.id?.toString() || null,
      type: "shopify_event", // Shopify sends topic in header, not body
      payload: data,
    };
  }

  getEventType(event: WebhookEvent): string {
    return event.type;
  }

  getEventId(event: WebhookEvent): string | null {
    return event.id;
  }
}

// =============================================================================
// HubSpot Webhook Handler
// =============================================================================

export class HubSpotWebhookHandler implements WebhookHandler {
  connector = "hubspot";

  async verifySignature(
    headers: Headers,
    body: string,
    secret: string
  ): Promise<boolean> {
    // HubSpot v3 signature (preferred)
    const v3Signature = headers.get("X-HubSpot-Signature-v3");
    const v3Timestamp = headers.get("X-HubSpot-Request-Timestamp");

    if (v3Signature && v3Timestamp) {
      return this.verifyV3Signature(v3Signature, v3Timestamp, body, secret);
    }

    // Fall back to v1 signature
    const v1Signature = headers.get("X-HubSpot-Signature");
    if (v1Signature) {
      return this.verifyV1Signature(v1Signature, body, secret);
    }

    return false;
  }

  private async verifyV3Signature(
    signature: string,
    timestamp: string,
    body: string,
    secret: string
  ): Promise<boolean> {
    try {
      // Check timestamp (reject if older than 5 minutes)
      const timestampAge = Date.now() - parseInt(timestamp, 10);
      if (timestampAge > 300000) return false;

      // V3: HMAC-SHA256 of timestamp + method + URI + body
      // For webhooks, method is POST and URI is the webhook path
      const method = "POST";
      const uri = ""; // HubSpot doesn't include URI in signature

      const signedPayload = `${method}${uri}${body}${timestamp}`;
      const expectedSignature = createHmac("sha256", secret)
        .update(signedPayload)
        .digest("base64");

      const sigBuffer = Buffer.from(signature, "base64");
      const expectedBuffer = Buffer.from(expectedSignature, "base64");

      return sigBuffer.length === expectedBuffer.length &&
        timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      return false;
    }
  }

  private async verifyV1Signature(
    signature: string,
    body: string,
    secret: string
  ): Promise<boolean> {
    try {
      // V1: SHA256 of client secret + body
      const signedPayload = secret + body;
      const expectedSignature = createHmac("sha256", "")
        .update(signedPayload)
        .digest("hex");

      return signature === expectedSignature;
    } catch {
      return false;
    }
  }

  parseEvent(body: string): WebhookEvent {
    const data = JSON.parse(body);

    // HubSpot sends an array of events
    if (Array.isArray(data) && data.length > 0) {
      const firstEvent = data[0];
      return {
        id: firstEvent.eventId?.toString() || null,
        type: firstEvent.subscriptionType || "unknown",
        payload: data,
        timestamp: firstEvent.occurredAt
          ? new Date(firstEvent.occurredAt).toISOString()
          : undefined,
      };
    }

    return {
      id: data.eventId?.toString() || null,
      type: data.subscriptionType || "unknown",
      payload: data,
    };
  }

  getEventType(event: WebhookEvent): string {
    return event.type;
  }

  getEventId(event: WebhookEvent): string | null {
    return event.id;
  }
}

// =============================================================================
// Handler Registry
// =============================================================================

const handlers: Record<string, WebhookHandler> = {
  stripe: new StripeWebhookHandler(),
  shopify: new ShopifyWebhookHandler(),
  hubspot: new HubSpotWebhookHandler(),
};

export function getWebhookHandler(connector: string): WebhookHandler | null {
  return handlers[connector] || null;
}

export function getSupportedConnectors(): string[] {
  return Object.keys(handlers);
}
