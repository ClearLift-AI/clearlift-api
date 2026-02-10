/**
 * Lemon Squeezy API Provider
 *
 * Handles authentication and data retrieval from Lemon Squeezy API
 * Uses Bearer token authentication with JSON:API format
 * Rate limit: 300 calls/min
 */

import { structuredLog } from '../../utils/structured-logger';

export interface LemonSqueezyConfig {
  apiKey: string;
}

export interface LemonSqueezyUser {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

export interface LemonSqueezyOrder {
  id: string;
  store_id: number;
  customer_id: number;
  identifier: string;
  order_number: number;
  user_name: string;
  user_email: string;
  currency: string;
  currency_rate: string;
  subtotal: number;
  discount_total: number;
  tax: number;
  total: number;
  subtotal_usd: number;
  discount_total_usd: number;
  tax_usd: number;
  total_usd: number;
  tax_name: string;
  tax_rate: string;
  status: 'pending' | 'failed' | 'paid' | 'refunded';
  status_formatted: string;
  refunded: boolean;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LemonSqueezySubscription {
  id: string;
  store_id: number;
  customer_id: number;
  order_id: number;
  product_id: number;
  variant_id: number;
  product_name: string;
  variant_name: string;
  user_name: string;
  user_email: string;
  status: 'on_trial' | 'active' | 'paused' | 'past_due' | 'unpaid' | 'cancelled' | 'expired';
  status_formatted: string;
  card_brand: string | null;
  card_last_four: string | null;
  pause: any;
  cancelled: boolean;
  trial_ends_at: string | null;
  billing_anchor: number;
  renews_at: string;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LemonSqueezyAccountInfo {
  user_id: string;
  user_name: string;
  user_email: string;
}

export class LemonSqueezyAPIProvider {
  private baseUrl = 'https://api.lemonsqueezy.com/v1';

  constructor(private config: LemonSqueezyConfig) {}

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json'
    };
  }

  /**
   * Validate API key by fetching the authenticated user
   */
  async validateAPIKey(): Promise<LemonSqueezyAccountInfo> {
    console.log('[LemonSqueezy] Validating API key...');

    const response = await fetch(`${this.baseUrl}/users/me`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Validation failed', { service: 'LemonSqueezy', error: errorText });
      throw new Error(`Invalid Lemon Squeezy API key: ${response.status}`);
    }

    const result = await response.json() as {
      data: {
        id: string;
        attributes: {
          name: string;
          email: string;
        };
      };
    };

    console.log('[LemonSqueezy] Validation successful, user_id:', result.data.id);

    return {
      user_id: result.data.id,
      user_name: result.data.attributes.name,
      user_email: result.data.attributes.email
    };
  }

  /**
   * List orders with pagination (JSON:API cursor-based)
   */
  async listOrders(options: {
    page?: number;
    perPage?: number;
    storeId?: number;
    userEmail?: string;
    status?: string;
  } = {}): Promise<{ data: LemonSqueezyOrder[]; hasMore: boolean; nextPage?: number }> {
    const params = new URLSearchParams();

    if (options.page) {
      params.append('page[number]', String(options.page));
    }
    params.append('page[size]', String(options.perPage || 100));

    if (options.storeId) {
      params.append('filter[store_id]', String(options.storeId));
    }
    if (options.userEmail) {
      params.append('filter[user_email]', options.userEmail);
    }
    if (options.status) {
      params.append('filter[status]', options.status);
    }

    const url = `${this.baseUrl}/orders?${params.toString()}`;
    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list orders: ${response.statusText}`);
    }

    const result = await response.json() as {
      data: Array<{ id: string; attributes: LemonSqueezyOrder }>;
      meta: { page: { currentPage: number; lastPage: number } };
    };

    const orders = result.data.map(item => {
      const { id: _attrId, ...restAttributes } = item.attributes;
      return {
        id: item.id,
        ...restAttributes
      } as LemonSqueezyOrder;
    });

    const hasMore = result.meta.page.currentPage < result.meta.page.lastPage;

    return {
      data: orders,
      hasMore,
      nextPage: hasMore ? result.meta.page.currentPage + 1 : undefined
    };
  }

  /**
   * List subscriptions with pagination
   */
  async listSubscriptions(options: {
    page?: number;
    perPage?: number;
    storeId?: number;
    status?: string;
  } = {}): Promise<{ data: LemonSqueezySubscription[]; hasMore: boolean; nextPage?: number }> {
    const params = new URLSearchParams();

    if (options.page) {
      params.append('page[number]', String(options.page));
    }
    params.append('page[size]', String(options.perPage || 100));

    if (options.storeId) {
      params.append('filter[store_id]', String(options.storeId));
    }
    if (options.status) {
      params.append('filter[status]', options.status);
    }

    const url = `${this.baseUrl}/subscriptions?${params.toString()}`;
    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list subscriptions: ${response.statusText}`);
    }

    const result = await response.json() as {
      data: Array<{ id: string; attributes: LemonSqueezySubscription }>;
      meta: { page: { currentPage: number; lastPage: number } };
    };

    const subscriptions = result.data.map(item => {
      const { id: _attrId, ...restAttributes } = item.attributes;
      return {
        id: item.id,
        ...restAttributes
      } as LemonSqueezySubscription;
    });

    const hasMore = result.meta.page.currentPage < result.meta.page.lastPage;

    return {
      data: subscriptions,
      hasMore,
      nextPage: hasMore ? result.meta.page.currentPage + 1 : undefined
    };
  }

  /**
   * Fetch all orders with automatic pagination
   */
  async fetchAllOrders(maxResults: number = 1000): Promise<LemonSqueezyOrder[]> {
    const allOrders: LemonSqueezyOrder[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && allOrders.length < maxResults) {
      const result = await this.listOrders({ page, perPage: 100 });
      allOrders.push(...result.data);
      hasMore = result.hasMore;
      page = result.nextPage || page + 1;
    }

    return allOrders.slice(0, maxResults);
  }
}
