/**
 * Paddle API Provider
 *
 * Handles authentication and data retrieval from Paddle Billing API
 * Supports both live and sandbox environments
 * API keys: pdl_live_* (live) or pdl_sdbx_* (sandbox)
 */

import { structuredLog } from '../../utils/structured-logger';

export interface PaddleConfig {
  apiKey: string;
  environment: 'live' | 'sandbox';
}

export interface PaddleTransaction {
  id: string;
  status: 'draft' | 'ready' | 'billed' | 'paid' | 'completed' | 'canceled' | 'past_due';
  customer_id: string | null;
  address_id: string | null;
  business_id: string | null;
  custom_data: Record<string, any> | null;
  origin: string;
  collection_mode: 'automatic' | 'manual';
  subscription_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  billing_details: {
    enable_checkout: boolean;
    payment_terms: {
      interval: string;
      frequency: number;
    };
    purchase_order_number: string | null;
  } | null;
  billing_period: {
    starts_at: string;
    ends_at: string;
  } | null;
  items: Array<{
    price_id: string;
    price: {
      id: string;
      product_id: string;
      description: string;
      unit_price: {
        amount: string;
        currency_code: string;
      };
    };
    quantity: number;
    proration: any;
  }>;
  details: {
    tax_rates_used: Array<{
      tax_rate: string;
      totals: {
        subtotal: string;
        discount: string;
        tax: string;
        total: string;
      };
    }>;
    totals: {
      subtotal: string;
      discount: string;
      tax: string;
      total: string;
      credit: string;
      balance: string;
      grand_total: string;
      fee: string | null;
      earnings: string | null;
      currency_code: string;
    };
    line_items: Array<{
      id: string;
      price_id: string;
      quantity: number;
      totals: {
        subtotal: string;
        tax: string;
        discount: string;
        total: string;
      };
      product: {
        id: string;
        name: string;
        description: string | null;
      };
    }>;
  };
  created_at: string;
  updated_at: string;
  billed_at: string | null;
}

export interface PaddleSubscription {
  id: string;
  status: 'active' | 'canceled' | 'past_due' | 'paused' | 'trialing';
  customer_id: string;
  address_id: string;
  business_id: string | null;
  currency_code: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  first_billed_at: string | null;
  next_billed_at: string | null;
  paused_at: string | null;
  canceled_at: string | null;
  collection_mode: 'automatic' | 'manual';
  billing_cycle: {
    interval: string;
    frequency: number;
  };
  items: Array<{
    status: string;
    quantity: number;
    recurring: boolean;
    created_at: string;
    updated_at: string;
    price_id: string;
    price: {
      id: string;
      product_id: string;
      unit_price: {
        amount: string;
        currency_code: string;
      };
    };
  }>;
  custom_data: Record<string, any> | null;
}

export interface PaddleAccountInfo {
  seller_id: string;
  seller_name: string;
  currency: string;
}

export class PaddleAPIProvider {
  private baseUrl: string;

  constructor(private config: PaddleConfig) {
    this.baseUrl = config.environment === 'sandbox'
      ? 'https://sandbox-api.paddle.com'
      : 'https://api.paddle.com';
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Validate API key by fetching event types (no special permissions required)
   */
  async validateAPIKey(): Promise<PaddleAccountInfo> {
    console.log('[Paddle] Validating API key...');
    console.log('[Paddle] Environment:', this.config.environment);
    console.log('[Paddle] Base URL:', this.baseUrl);

    // Use event-types endpoint which requires minimal permissions
    const response = await fetch(`${this.baseUrl}/event-types`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Validation failed', { service: 'Paddle', error: errorText });
      throw new Error(`Invalid Paddle API key: ${response.status}`);
    }

    // Key is valid - extract seller info from the key prefix
    const keyParts = this.config.apiKey.split('_');
    const isLive = keyParts[1] === 'live';

    // Generate a unique seller ID based on key hash
    const encoder = new TextEncoder();
    const data = encoder.encode(this.config.apiKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const keyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    console.log('[Paddle] Validation successful');

    return {
      seller_id: `pdl_${keyHash.substring(0, 16)}`,
      seller_name: isLive ? 'Paddle Account (Live)' : 'Paddle Account (Sandbox)',
      currency: 'USD'
    };
  }

  /**
   * List transactions with pagination
   */
  async listTransactions(options: {
    after?: string;
    perPage?: number;
    status?: string;
    customerId?: string;
    subscriptionId?: string;
    createdAfter?: string;
    createdBefore?: string;
  } = {}): Promise<{ data: PaddleTransaction[]; hasMore: boolean; nextAfter?: string }> {
    const params = new URLSearchParams();

    if (options.after) {
      params.append('after', options.after);
    }
    params.append('per_page', String(options.perPage || 100));

    if (options.status) {
      params.append('status', options.status);
    }
    if (options.customerId) {
      params.append('customer_id', options.customerId);
    }
    if (options.subscriptionId) {
      params.append('subscription_id', options.subscriptionId);
    }

    const url = `${this.baseUrl}/transactions?${params.toString()}`;
    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list transactions: ${response.statusText}`);
    }

    const result = await response.json() as {
      data: PaddleTransaction[];
      meta: {
        request_id: string;
        pagination: {
          per_page: number;
          next: string | null;
          has_more: boolean;
          estimated_total: number;
        };
      };
    };

    return {
      data: result.data,
      hasMore: result.meta.pagination.has_more,
      nextAfter: result.meta.pagination.next || undefined
    };
  }

  /**
   * List subscriptions with pagination
   */
  async listSubscriptions(options: {
    after?: string;
    perPage?: number;
    status?: string;
    customerId?: string;
  } = {}): Promise<{ data: PaddleSubscription[]; hasMore: boolean; nextAfter?: string }> {
    const params = new URLSearchParams();

    if (options.after) {
      params.append('after', options.after);
    }
    params.append('per_page', String(options.perPage || 100));

    if (options.status) {
      params.append('status', options.status);
    }
    if (options.customerId) {
      params.append('customer_id', options.customerId);
    }

    const url = `${this.baseUrl}/subscriptions?${params.toString()}`;
    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list subscriptions: ${response.statusText}`);
    }

    const result = await response.json() as {
      data: PaddleSubscription[];
      meta: {
        request_id: string;
        pagination: {
          per_page: number;
          next: string | null;
          has_more: boolean;
          estimated_total: number;
        };
      };
    };

    return {
      data: result.data,
      hasMore: result.meta.pagination.has_more,
      nextAfter: result.meta.pagination.next || undefined
    };
  }

  /**
   * Fetch all transactions with automatic pagination
   */
  async fetchAllTransactions(maxResults: number = 1000): Promise<PaddleTransaction[]> {
    const allTransactions: PaddleTransaction[] = [];
    let after: string | undefined;
    let hasMore = true;

    while (hasMore && allTransactions.length < maxResults) {
      const result = await this.listTransactions({ after, perPage: 100 });
      allTransactions.push(...result.data);
      hasMore = result.hasMore;
      after = result.nextAfter;
    }

    return allTransactions.slice(0, maxResults);
  }
}
