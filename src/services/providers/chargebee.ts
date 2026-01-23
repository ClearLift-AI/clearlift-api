/**
 * Chargebee API Provider
 *
 * Handles authentication and data retrieval from Chargebee API
 * Uses HTTP Basic authentication (API key as username, empty password)
 * Rate limit: 150 requests/min
 */

export interface ChargebeeConfig {
  apiKey: string;
  site: string;  // e.g., "mycompany" for mycompany.chargebee.com
}

export interface ChargebeeInvoice {
  id: string;
  customer_id: string;
  subscription_id: string | null;
  recurring: boolean;
  status: 'paid' | 'posted' | 'payment_due' | 'not_paid' | 'voided' | 'pending';
  price_type: 'tax_exclusive' | 'tax_inclusive';
  date: number;  // Unix timestamp
  due_date: number | null;
  net_term_days: number | null;
  currency_code: string;
  total: number;  // In cents
  amount_paid: number;
  amount_adjusted: number;
  write_off_amount: number;
  credits_applied: number;
  amount_due: number;
  paid_at: number | null;
  dunning_status: string | null;
  next_retry_at: number | null;
  voided_at: number | null;
  resource_version: number;
  updated_at: number;
  generated_at: number;
  sub_total: number;
  tax: number;
  line_items: Array<{
    id: string;
    subscription_id: string | null;
    date_from: number;
    date_to: number;
    unit_amount: number;
    quantity: number;
    amount: number;
    pricing_model: string;
    is_taxed: boolean;
    tax_amount: number;
    description: string;
    entity_type: string;
    entity_id: string | null;
  }>;
  discounts?: Array<{
    amount: number;
    description: string;
    entity_type: string;
    entity_id: string | null;
  }>;
  taxes?: Array<{
    name: string;
    amount: number;
    description: string;
  }>;
  linked_payments?: Array<{
    txn_id: string;
    applied_amount: number;
    applied_at: number;
    txn_status: string;
    txn_date: number;
    txn_amount: number;
  }>;
  billing_address?: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    company: string | null;
    phone: string | null;
    line1: string | null;
    line2: string | null;
    line3: string | null;
    city: string | null;
    state_code: string | null;
    state: string | null;
    country: string | null;
    zip: string | null;
  };
}

export interface ChargebeeSubscription {
  id: string;
  customer_id: string;
  plan_id: string;
  plan_quantity: number;
  plan_unit_price: number;
  billing_period: number;
  billing_period_unit: 'day' | 'week' | 'month' | 'year';
  plan_free_quantity: number;
  status: 'future' | 'in_trial' | 'active' | 'non_renewing' | 'paused' | 'cancelled';
  start_date: number;
  trial_start: number | null;
  trial_end: number | null;
  current_term_start: number;
  current_term_end: number;
  next_billing_at: number | null;
  remaining_billing_cycles: number | null;
  created_at: number;
  updated_at: number;
  has_scheduled_changes: boolean;
  resource_version: number;
  deleted: boolean;
  currency_code: string;
  mrr: number;
}

export interface ChargebeeCustomer {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  auto_collection: 'on' | 'off';
  net_term_days: number;
  created_at: number;
  updated_at: number;
  resource_version: number;
  deleted: boolean;
}

export interface ChargebeeAccountInfo {
  site_id: string;
  site_name: string;
  default_currency: string;
}

export class ChargebeeAPIProvider {
  private baseUrl: string;

  constructor(private config: ChargebeeConfig) {
    this.baseUrl = `https://${config.site}.chargebee.com/api/v2`;
  }

  private getHeaders(): Record<string, string> {
    // HTTP Basic auth: API key as username, empty password
    const credentials = btoa(`${this.config.apiKey}:`);
    return {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
  }

  /**
   * Validate API key by fetching site configuration
   */
  async validateAPIKey(): Promise<ChargebeeAccountInfo> {
    console.log('[Chargebee] Validating API key...');
    console.log('[Chargebee] Site:', this.config.site);

    const response = await fetch(`${this.baseUrl}/configurations`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Chargebee] Validation failed:', errorText);
      throw new Error(`Invalid Chargebee API key: ${response.status}`);
    }

    const result = await response.json() as {
      configurations: Array<{
        domain: string;
        product_catalog_version: string;
        chrono_trigger_date: string;
      }>;
    };

    console.log('[Chargebee] Validation successful');

    return {
      site_id: this.config.site,
      site_name: this.config.site,
      default_currency: 'USD'  // Would need separate call to get actual currency
    };
  }

  /**
   * List invoices with pagination
   */
  async listInvoices(options: {
    offset?: string;
    limit?: number;
    status?: string;
    customerId?: string;
    paidOnAfter?: number;
    paidOnBefore?: number;
    updatedAfter?: number;
  } = {}): Promise<{ data: ChargebeeInvoice[]; hasMore: boolean; nextOffset?: string }> {
    const params = new URLSearchParams();

    if (options.offset) {
      params.append('offset', options.offset);
    }
    params.append('limit', String(options.limit || 100));

    if (options.status) {
      params.append('status[is]', options.status);
    }
    if (options.customerId) {
      params.append('customer_id[is]', options.customerId);
    }
    if (options.paidOnAfter) {
      params.append('paid_at[after]', String(options.paidOnAfter));
    }
    if (options.paidOnBefore) {
      params.append('paid_at[before]', String(options.paidOnBefore));
    }
    if (options.updatedAfter) {
      params.append('updated_at[after]', String(options.updatedAfter));
    }

    params.append('sort_by[asc]', 'date');

    const url = `${this.baseUrl}/invoices?${params.toString()}`;
    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list invoices: ${response.statusText}`);
    }

    const result = await response.json() as {
      list: Array<{ invoice: ChargebeeInvoice }>;
      next_offset?: string;
    };

    const invoices = result.list.map(item => item.invoice);

    return {
      data: invoices,
      hasMore: !!result.next_offset,
      nextOffset: result.next_offset
    };
  }

  /**
   * List subscriptions with pagination
   */
  async listSubscriptions(options: {
    offset?: string;
    limit?: number;
    status?: string;
    customerId?: string;
    planId?: string;
    updatedAfter?: number;
  } = {}): Promise<{ data: ChargebeeSubscription[]; hasMore: boolean; nextOffset?: string }> {
    const params = new URLSearchParams();

    if (options.offset) {
      params.append('offset', options.offset);
    }
    params.append('limit', String(options.limit || 100));

    if (options.status) {
      params.append('status[is]', options.status);
    }
    if (options.customerId) {
      params.append('customer_id[is]', options.customerId);
    }
    if (options.planId) {
      params.append('plan_id[is]', options.planId);
    }
    if (options.updatedAfter) {
      params.append('updated_at[after]', String(options.updatedAfter));
    }

    params.append('sort_by[asc]', 'created_at');

    const url = `${this.baseUrl}/subscriptions?${params.toString()}`;
    const response = await fetch(url, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to list subscriptions: ${response.statusText}`);
    }

    const result = await response.json() as {
      list: Array<{ subscription: ChargebeeSubscription; customer?: ChargebeeCustomer }>;
      next_offset?: string;
    };

    const subscriptions = result.list.map(item => item.subscription);

    return {
      data: subscriptions,
      hasMore: !!result.next_offset,
      nextOffset: result.next_offset
    };
  }

  /**
   * Get a customer by ID
   */
  async getCustomer(customerId: string): Promise<ChargebeeCustomer> {
    const response = await fetch(`${this.baseUrl}/customers/${customerId}`, {
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(`Failed to get customer: ${response.statusText}`);
    }

    const result = await response.json() as { customer: ChargebeeCustomer };
    return result.customer;
  }

  /**
   * Fetch all invoices with automatic pagination
   */
  async fetchAllInvoices(maxResults: number = 1000): Promise<ChargebeeInvoice[]> {
    const allInvoices: ChargebeeInvoice[] = [];
    let offset: string | undefined;
    let hasMore = true;

    while (hasMore && allInvoices.length < maxResults) {
      const result = await this.listInvoices({ offset, limit: 100 });
      allInvoices.push(...result.data);
      hasMore = result.hasMore;
      offset = result.nextOffset;
    }

    return allInvoices.slice(0, maxResults);
  }
}
