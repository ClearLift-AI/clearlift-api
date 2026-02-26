/**
 * Webhook Handlers
 *
 * Platform-specific webhook signature verification and event parsing.
 * Each handler implements the WebhookHandler interface.
 *
 * Includes unified event type normalization for cross-connector reporting.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// =============================================================================
// Unified Event Types
// =============================================================================

/**
 * Unified event types for cross-connector normalization.
 * Maps connector-specific events to standard types.
 */
export type UnifiedEventType =
  // Acquisition
  | 'lead.created'
  | 'lead.qualified'
  | 'contact.created'
  | 'form.submitted'
  // Engagement
  | 'meeting.scheduled'
  | 'meeting.completed'
  | 'demo.requested'
  | 'trial.started'
  | 'quote.sent'
  | 'quote.approved'
  // Conversion
  | 'subscription.created'
  | 'subscription.upgraded'
  | 'payment.completed'
  | 'order.placed'
  | 'order.fulfilled'
  | 'deal.won'
  | 'job.completed'
  | 'invoice.paid'
  // Retention
  | 'subscription.renewed'
  | 'subscription.cancelled'
  | 'refund.issued'
  // Lifecycle
  | 'app.uninstalled'
  // GDPR Compliance
  | 'gdpr.customers_data_request'
  | 'gdpr.customers_redact'
  | 'gdpr.shop_redact';

/**
 * Connector event mappings to unified types.
 * Key: connector provider ID
 * Value: Map of connector event name to unified event type
 */
const CONNECTOR_EVENT_MAPPINGS: Record<string, Record<string, UnifiedEventType>> = {
  // Stripe
  stripe: {
    'customer.subscription.created': 'subscription.created',
    'subscription_created': 'subscription.created',
    'customer.subscription.updated': 'subscription.upgraded',
    'invoice.paid': 'invoice.paid',
    'invoice.payment_succeeded': 'payment.completed',
    'payment_intent.succeeded': 'payment.completed',
    'payment_success': 'payment.completed',
    'charge.succeeded': 'payment.completed',
    'checkout.session.completed': 'payment.completed',
    'customer.subscription.deleted': 'subscription.cancelled',
    'charge.refunded': 'refund.issued',
    'trial_started': 'trial.started',
  },

  // Shopify
  shopify: {
    'orders/create': 'order.placed',
    'order_placed': 'order.placed',
    'orders/paid': 'payment.completed',
    'orders/fulfilled': 'order.fulfilled',
    'order_fulfilled': 'order.fulfilled',
    'checkouts/create': 'order.placed',
    'checkout_started': 'order.placed',
    'refunds/create': 'refund.issued',
    'app/uninstalled': 'app.uninstalled',
    'customers/data_request': 'gdpr.customers_data_request',
    'customers/redact': 'gdpr.customers_redact',
    'shop/redact': 'gdpr.shop_redact',
  },

  // HubSpot
  hubspot: {
    'contact.creation': 'contact.created',
    'contact_created': 'contact.created',
    'contact.propertyChange': 'lead.qualified',
    'deal.creation': 'lead.qualified',
    'deal_created': 'lead.qualified',
    'deal.propertyChange': 'deal.won',
    'deal_won': 'deal.won',
    'form.submitted': 'form.submitted',
    'form_submitted': 'form.submitted',
    'meeting.creation': 'meeting.scheduled',
  },

  // Salesforce
  salesforce: {
    'Lead.create': 'lead.created',
    'lead_created': 'lead.created',
    'Lead.convert': 'lead.qualified',
    'lead_converted': 'lead.qualified',
    'Opportunity.create': 'lead.qualified',
    'opportunity_created': 'lead.qualified',
    'Opportunity.won': 'deal.won',
    'opportunity_won': 'deal.won',
    'Contact.create': 'contact.created',
  },

  // Calendly
  calendly: {
    'invitee.created': 'meeting.scheduled',
    'meeting_scheduled': 'meeting.scheduled',
    'invitee.canceled': 'meeting.scheduled',
    'meeting_completed': 'meeting.completed',
  },

  // Jobber
  jobber: {
    'quote.created': 'quote.sent',
    'quote_sent': 'quote.sent',
    'quote.approved': 'quote.approved',
    'job.completed': 'job.completed',
    'job_completed': 'job.completed',
    'invoice.paid': 'invoice.paid',
    'invoice_paid': 'invoice.paid',
  },

  // PayPal
  paypal: {
    'PAYMENT.CAPTURE.COMPLETED': 'payment.completed',
    'payment_captured': 'payment.completed',
    'BILLING.SUBSCRIPTION.CREATED': 'subscription.created',
    'subscription_activated': 'subscription.created',
    'BILLING.SUBSCRIPTION.CANCELLED': 'subscription.cancelled',
    'PAYMENT.CAPTURE.REFUNDED': 'refund.issued',
  },

  // Square
  square: {
    'payment.completed': 'payment.completed',
    'payment_completed': 'payment.completed',
    'order.created': 'order.placed',
    'order_created': 'order.placed',
    'refund.created': 'refund.issued',
  },

  // Pipedrive
  pipedrive: {
    'added.person': 'contact.created',
    'person_created': 'contact.created',
    'added.deal': 'lead.qualified',
    'deal_created': 'lead.qualified',
    'updated.deal': 'deal.won',
    'deal_won': 'deal.won',
  },

  // Close
  close: {
    'lead.created': 'lead.created',
    'lead_created': 'lead.created',
    'opportunity.won': 'deal.won',
    'opportunity_won': 'deal.won',
  },

  // Acuity
  acuity: {
    'appointment.scheduled': 'meeting.scheduled',
    'appointment_scheduled': 'meeting.scheduled',
    'appointment.completed': 'meeting.completed',
  },

  // Cal.com
  cal_com: {
    'BOOKING_CREATED': 'meeting.scheduled',
    'booking_created': 'meeting.scheduled',
    'BOOKING_RESCHEDULED': 'meeting.scheduled',
  },
};

/**
 * Convert a connector-specific event to its unified type.
 */
export function toUnifiedEventType(connector: string, connectorEvent: string): UnifiedEventType | null {
  const mapping = CONNECTOR_EVENT_MAPPINGS[connector];
  if (!mapping) return null;
  return mapping[connectorEvent] || null;
}

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
  getUnifiedEventType(event: WebhookEvent): UnifiedEventType | null;
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

  getUnifiedEventType(event: WebhookEvent): UnifiedEventType | null {
    return toUnifiedEventType(this.connector, event.type);
  }
}

// =============================================================================
// Shopify Webhook Handler
// =============================================================================

export class ShopifyWebhookHandler implements WebhookHandler {
  connector = "shopify";
  private currentTopic: string = "shopify_event";

  async verifySignature(
    headers: Headers,
    body: string,
    secret: string
  ): Promise<boolean> {
    const signature = headers.get("X-Shopify-Hmac-Sha256");
    if (!signature) return false;

    // Store topic from header for event type normalization
    const topic = headers.get("X-Shopify-Topic");
    if (topic) {
      this.currentTopic = topic;
    }

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
      type: this.currentTopic, // Use topic from header
      payload: data,
    };
  }

  getEventType(event: WebhookEvent): string {
    return event.type;
  }

  getEventId(event: WebhookEvent): string | null {
    return event.id;
  }

  getUnifiedEventType(event: WebhookEvent): UnifiedEventType | null {
    return toUnifiedEventType(this.connector, event.type);
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

  getUnifiedEventType(event: WebhookEvent): UnifiedEventType | null {
    return toUnifiedEventType(this.connector, event.type);
  }
}

// =============================================================================
// Generic Webhook Handler
// =============================================================================

/**
 * Generic Webhook Handler — events go through R2/AE pipeline (not direct to conversions).
 * Verifies HMAC-SHA256 signature using X-Webhook-Signature header.
 */
export class GenericWebhookHandler implements WebhookHandler {
  connector = "webhook";

  async verifySignature(
    headers: Headers,
    body: string,
    secret: string
  ): Promise<boolean> {
    const signature = headers.get("X-Webhook-Signature") || headers.get("x-webhook-signature");
    if (!signature) return false;

    try {
      const expectedSignature = createHmac("sha256", secret)
        .update(body)
        .digest("hex");

      const sigBuffer = Buffer.from(signature, "hex");
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
      id: data.id?.toString() || null,
      type: data.event_type || data.type || data.event || "webhook_event",
      payload: data,
      timestamp: data.timestamp || data.created_at || undefined,
    };
  }

  getEventType(event: WebhookEvent): string {
    return event.type;
  }

  getEventId(event: WebhookEvent): string | null {
    return event.id;
  }

  getUnifiedEventType(_event: WebhookEvent): UnifiedEventType | null {
    // Generic webhooks don't have unified event mapping
    // They go through R2/AE → AggregationWorkflow matching
    return null;
  }
}

// =============================================================================
// Handler Registry
// =============================================================================

const handlers: Record<string, WebhookHandler> = {
  stripe: new StripeWebhookHandler(),
  shopify: new ShopifyWebhookHandler(),
  hubspot: new HubSpotWebhookHandler(),
  webhook: new GenericWebhookHandler(),
};

export function getWebhookHandler(connector: string): WebhookHandler | null {
  return handlers[connector] || null;
}

export function getSupportedConnectors(): string[] {
  return Object.keys(handlers);
}
