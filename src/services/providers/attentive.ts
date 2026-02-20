/**
 * Attentive API Provider
 *
 * Handle communication with Attentive SMS Marketing API
 * API Docs: https://docs.attentive.com/
 */

const ATTENTIVE_API_BASE = 'https://api.attentivemobile.com/v1';

export interface AttentiveConfig {
  apiKey: string;
}

/**
 * Raw Attentive webhook payload (as received from Attentive).
 * @see https://docs.attentive.com/pages/webhooks/webhook-payloads/
 */
export interface AttentiveRawWebhookPayload {
  type: string;               // 'sms.sent' | 'sms.message_link_click' | 'sms.subscribed' | etc.
  timestamp: number;          // Unix milliseconds
  company: {
    display_name: string;
    company_id: string;
  };
  subscriber: {
    email?: string;
    phone?: string;
    external_id?: string;
  };
  message?: {
    id: string;
    type?: string;
    name?: string;
    text?: string;
    channel?: string;
    subject?: string;
  };
  subscription?: {
    type: string;  // 'MARKETING' | 'TRANSACTIONAL'
  };
  creative?: {
    name?: string;
    type?: string;
  };
  link?: {
    url?: string;
  };
  user_property?: {
    id: string;
    name: string;
    value: string;
  };
}

export interface AttentiveAccountInfo {
  company_id: string;
  company_name: string;
  timezone?: string;
  country?: string;
}

export interface AttentiveSubscriber {
  id: string;
  phone: string;
  email?: string;
  subscribed_sms: boolean;
  subscribed_email: boolean;
  created_at: string;
  custom_attributes?: Record<string, any>;
}

export class AttentiveAPIProvider {
  private apiKey: string;

  constructor(config: AttentiveConfig) {
    this.apiKey = config.apiKey;
  }

  /**
   * Make authenticated request to Attentive API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${ATTENTIVE_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.message || errorJson.error || errorText;
      } catch {
        errorMessage = errorText;
      }

      throw new Error(`Attentive API error (${response.status}): ${errorMessage}`);
    }

    return response.json();
  }

  /**
   * Validate API key by calling /me endpoint
   */
  async validateAPIKey(apiKey: string): Promise<AttentiveAccountInfo> {
    try {
      // The /me endpoint returns current authenticated user/app info
      const response = await this.request<any>('/me');

      return {
        company_id: response.companyId || response.company_id || 'unknown',
        company_name: response.companyName || response.company_name || 'Attentive Account',
        timezone: response.timezone,
        country: response.country,
      };
    } catch (err: any) {
      if (err.message?.includes('401') || err.message?.includes('403')) {
        throw new Error('Invalid API key. Please check your Attentive API key and try again.');
      }
      throw err;
    }
  }

  /**
   * Test the connection by fetching basic account info
   */
  async testConnection(): Promise<{ success: boolean; error?: string; account?: AttentiveAccountInfo }> {
    try {
      const account = await this.validateAPIKey(this.apiKey);
      return { success: true, account };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * List subscribers (paginated)
   */
  async listSubscribers(params: {
    limit?: number;
    cursor?: string;
    status?: 'subscribed' | 'unsubscribed' | 'all';
  } = {}): Promise<{ subscribers: AttentiveSubscriber[]; next_cursor?: string }> {
    const queryParams = new URLSearchParams();
    if (params.limit) queryParams.set('limit', params.limit.toString());
    if (params.cursor) queryParams.set('cursor', params.cursor);
    if (params.status && params.status !== 'all') queryParams.set('status', params.status);

    const endpoint = `/subscriptions${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const response = await this.request<any>(endpoint);

    return {
      subscribers: response.subscriptions || response.data || [],
      next_cursor: response.next_cursor || response.cursor,
    };
  }

  /**
   * Get subscriber by phone number
   */
  async getSubscriberByPhone(phone: string): Promise<AttentiveSubscriber | null> {
    try {
      const response = await this.request<any>(`/subscriptions?phone=${encodeURIComponent(phone)}`);
      const subscribers = response.subscriptions || response.data || [];
      return subscribers.length > 0 ? subscribers[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Get subscriber by email
   */
  async getSubscriberByEmail(email: string): Promise<AttentiveSubscriber | null> {
    try {
      const response = await this.request<any>(`/subscriptions?email=${encodeURIComponent(email)}`);
      const subscribers = response.subscriptions || response.data || [];
      return subscribers.length > 0 ? subscribers[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Get recent subscriber count (for testing)
   */
  async getSubscriberCount(): Promise<number> {
    try {
      const response = await this.listSubscribers({ limit: 1 });
      // Note: This is an approximation - actual count may require a different endpoint
      return response.subscribers.length > 0 ? 1 : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Verify Attentive webhook signature using HMAC-SHA256.
   * @see https://docs.attentive.com/pages/webhooks/webhook-authentication/
   *
   * @param body - Raw request body as string
   * @param signature - Value of x-attentive-hmac-sha256 header
   * @param secret - Webhook signing secret from Attentive dashboard
   * @returns True if signature is valid
   */
  static async verifyWebhookSignature(
    body: string,
    signature: string,
    secret: string
  ): Promise<boolean> {
    if (!signature || !secret) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(body)
    );

    const expectedHex = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison
    if (signature.length !== expectedHex.length) return false;
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Parse raw Attentive webhook payload into normalized event.
   */
  static parseWebhookEvent(payload: AttentiveRawWebhookPayload): {
    event_type: string;
    message_id: string;
    subscriber_id: string;
    subscriber_email?: string;
    campaign_id?: string;
    campaign_name?: string;
    link_url?: string;
    timestamp: string;
    company_id: string;
    metadata: Record<string, unknown>;
  } {
    return {
      event_type: payload.type,
      message_id: payload.message?.id || `${payload.type}-${payload.timestamp}`,
      subscriber_id: payload.subscriber?.external_id || payload.subscriber?.phone || 'unknown',
      subscriber_email: payload.subscriber?.email || undefined,
      campaign_id: payload.message?.id,
      campaign_name: payload.message?.name || payload.creative?.name,
      link_url: payload.link?.url,
      timestamp: new Date(payload.timestamp).toISOString(),
      company_id: payload.company?.company_id,
      metadata: {
        channel: payload.message?.channel,
        message_type: payload.message?.type,
        subscription_type: payload.subscription?.type,
        creative_type: payload.creative?.type,
      },
    };
  }

  /**
   * Attempt to register webhook URL with Attentive.
   * Uses the webhooks API if available. Non-fatal — if this fails,
   * the user can configure webhooks manually in the Attentive dashboard.
   */
  async registerWebhook(
    webhookUrl: string,
    eventTypes: string[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request<any>('/webhooks', {
        method: 'POST',
        body: JSON.stringify({
          url: webhookUrl,
          events: eventTypes,
        }),
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
