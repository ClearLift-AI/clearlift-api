/**
 * Recurly API Provider
 *
 * Handles authentication and data retrieval from Recurly API v3
 * Uses Basic authentication with just the API key (no colon separator)
 * Requires version header: Recurly-Version: v2021-02-25
 */

import { structuredLog } from '../../utils/structured-logger';

export interface RecurlyConfig {
  apiKey: string;
}

export interface RecurlyInvoice {
  id: string;
  object: 'invoice';
  type: 'charge' | 'credit' | 'legacy';
  origin: string;
  state: 'pending' | 'processing' | 'past_due' | 'paid' | 'failed' | 'voided' | 'closed';
  account: {
    id: string;
    code: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
  };
  subscription_ids: string[];
  previous_invoice_id: string | null;
  number: string;
  collection_method: 'automatic' | 'manual';
  po_number: string | null;
  net_terms: number;
  currency: string;
  balance: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  refundable_amount: number;
  paid: number;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  closed_at: string | null;
  billing_info_id: string | null;
  line_items: {
    has_more: boolean;
    data: Array<{
      id: string;
      type: string;
      description: string;
      origin: string;
      currency: string;
      unit_amount: number;
      quantity: number;
      subtotal: number;
      tax: number;
      discount: number;
      total: number;
      refund: number;
      refundable: boolean;
      created_at: string;
      updated_at: string;
    }>;
  };
  transactions: Array<{
    id: string;
    type: string;
    origin: string;
    currency: string;
    amount: number;
    status: string;
    success: boolean;
    refunded: boolean;
    billing_address: any;
    collection_method: string;
    payment_method: {
      card_type: string | null;
      first_six: string | null;
      last_four: string | null;
      exp_month: number | null;
      exp_year: number | null;
    } | null;
    created_at: string;
    updated_at: string;
  }>;
  address: {
    name_on_account: string | null;
    company: string | null;
    phone: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
  } | null;
}

export interface RecurlySubscription {
  id: string;
  object: 'subscription';
  uuid: string;
  account: {
    id: string;
    code: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  };
  plan: {
    id: string;
    code: string;
    name: string;
  };
  state: 'active' | 'canceled' | 'expired' | 'failed' | 'future' | 'paused';
  quantity: number;
  unit_amount: number;
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  add_ons: Array<{
    id: string;
    code: string;
    name: string;
    quantity: number;
    unit_amount: number;
  }>;
  add_ons_total: number;
  current_period_started_at: string;
  current_period_ends_at: string;
  current_term_started_at: string | null;
  current_term_ends_at: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  remaining_billing_cycles: number | null;
  total_billing_cycles: number | null;
  renewal_billing_cycles: number | null;
  auto_renew: boolean;
  paused_at: string | null;
  remaining_pause_cycles: number | null;
  converted_at: string | null;
  activated_at: string | null;
  canceled_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  collection_method: 'automatic' | 'manual';
  po_number: string | null;
  net_terms: number;
  customer_notes: string | null;
  terms_and_conditions: string | null;
  gateway_code: string | null;
  billing_info_id: string | null;
}

export interface RecurlySite {
  id: string;
  object: 'site';
  subdomain: string;
  public_api_key: string;
  mode: 'production' | 'sandbox';
  features: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  settings: {
    billing: {
      default_currency: string;
    };
  };
}

export interface RecurlyAccountInfo {
  site_id: string;
  site_subdomain: string;
  default_currency: string;
}

export class RecurlyAPIProvider {
  private baseUrl = 'https://v3.recurly.com';
  private apiVersion = 'v2021-02-25';

  constructor(private config: RecurlyConfig) {}

  private getHeaders(): Record<string, string> {
    // Basic auth with just the API key (no colon)
    const credentials = btoa(this.config.apiKey);
    return {
      'Authorization': `Basic ${credentials}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Recurly-Version': this.apiVersion
    };
  }

  /**
   * Validate API key by fetching site information
   */
  async validateAPIKey(): Promise<RecurlyAccountInfo> {
    console.log('[Recurly] Validating API key...');

    const response = await fetch(`${this.baseUrl}/sites`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      structuredLog('ERROR', 'Validation failed', { service: 'Recurly', error: errorText });
      throw new Error(`Invalid Recurly API key: ${response.status}`);
    }

    const result = await response.json() as {
      has_more: boolean;
      data: RecurlySite[];
    };

    if (!result.data || result.data.length === 0) {
      throw new Error('No Recurly sites found for this API key');
    }

    const site = result.data[0];
    console.log('[Recurly] Validation successful, site:', site.subdomain);

    return {
      site_id: site.id,
      site_subdomain: site.subdomain,
      default_currency: site.settings?.billing?.default_currency || 'USD'
    };
  }

  /**
   * List invoices with pagination
   */
  async listInvoices(options: {
    cursor?: string;
    limit?: number;
    state?: string;
    type?: string;
    beginTime?: string;
    endTime?: string;
    sort?: 'created_at' | 'updated_at';
    order?: 'asc' | 'desc';
  } = {}): Promise<{ data: RecurlyInvoice[]; hasMore: boolean; nextCursor?: string }> {
    const params = new URLSearchParams();

    params.append('limit', String(options.limit || 100));

    if (options.state) {
      params.append('state', options.state);
    }
    if (options.type) {
      params.append('type', options.type);
    }
    if (options.beginTime) {
      params.append('begin_time', options.beginTime);
    }
    if (options.endTime) {
      params.append('end_time', options.endTime);
    }
    if (options.sort) {
      params.append('sort', options.sort);
    }
    if (options.order) {
      params.append('order', options.order);
    }

    let url = `${this.baseUrl}/invoices?${params.toString()}`;
    if (options.cursor) {
      url = options.cursor;  // Recurly cursors are full URLs
    }

    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list invoices: ${response.statusText}`);
    }

    const result = await response.json() as {
      has_more: boolean;
      next: string | null;
      data: RecurlyInvoice[];
    };

    return {
      data: result.data,
      hasMore: result.has_more,
      nextCursor: result.next || undefined
    };
  }

  /**
   * List subscriptions with pagination
   */
  async listSubscriptions(options: {
    cursor?: string;
    limit?: number;
    state?: string;
    planId?: string;
    beginTime?: string;
    endTime?: string;
    sort?: 'created_at' | 'updated_at';
    order?: 'asc' | 'desc';
  } = {}): Promise<{ data: RecurlySubscription[]; hasMore: boolean; nextCursor?: string }> {
    const params = new URLSearchParams();

    params.append('limit', String(options.limit || 100));

    if (options.state) {
      params.append('state', options.state);
    }
    if (options.planId) {
      params.append('plan_id', options.planId);
    }
    if (options.beginTime) {
      params.append('begin_time', options.beginTime);
    }
    if (options.endTime) {
      params.append('end_time', options.endTime);
    }
    if (options.sort) {
      params.append('sort', options.sort);
    }
    if (options.order) {
      params.append('order', options.order);
    }

    let url = `${this.baseUrl}/subscriptions?${params.toString()}`;
    if (options.cursor) {
      url = options.cursor;
    }

    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list subscriptions: ${response.statusText}`);
    }

    const result = await response.json() as {
      has_more: boolean;
      next: string | null;
      data: RecurlySubscription[];
    };

    return {
      data: result.data,
      hasMore: result.has_more,
      nextCursor: result.next || undefined
    };
  }

  /**
   * Fetch all invoices with automatic pagination
   */
  async fetchAllInvoices(maxResults: number = 1000): Promise<RecurlyInvoice[]> {
    const allInvoices: RecurlyInvoice[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore && allInvoices.length < maxResults) {
      const result = await this.listInvoices({
        cursor,
        limit: 100,
        sort: 'created_at',
        order: 'desc'
      });
      allInvoices.push(...result.data);
      hasMore = result.hasMore;
      cursor = result.nextCursor;
    }

    return allInvoices.slice(0, maxResults);
  }
}
