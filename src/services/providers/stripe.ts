/**
 * Stripe API Provider
 *
 * Handles authentication and data retrieval from Stripe API
 * Supports filtering on standard fields and arbitrary user-defined metadata
 */

import { FilterRule, FilterCondition } from '../filters/types';
import { structuredLog } from '../../utils/structured-logger';

export interface StripeConfig {
  apiKey: string;
  apiVersion?: string;
}

export interface StripeCharge {
  id: string;
  amount: number;
  currency: string;
  status: string;
  description?: string;
  metadata: Record<string, any>;
  created: number;
  customer?: string;
  payment_intent?: string;
  invoice?: string;
  // Expanded fields
  customer_object?: StripeCustomer;
  invoice_object?: StripeInvoice;
}

export interface StripeProduct {
  id: string;
  name: string;
  description?: string;
  metadata: Record<string, any>;
  created: number;
}

export interface StripePrice {
  id: string;
  product: string | StripeProduct;
  unit_amount?: number;
  currency: string;
  metadata: Record<string, any>;
  created: number;
}

export interface StripeCustomer {
  id: string;
  email?: string;
  name?: string;
  metadata: Record<string, any>;
  created: number;
}

export interface StripeInvoice {
  id: string;
  customer: string;
  subscription?: string;
  metadata: Record<string, any>;
  lines: {
    data: Array<{
      price: string | StripePrice;
      quantity: number;
      amount: number;
    }>;
  };
}

export interface StripeAccountInfo {
  stripe_account_id: string;
  business_profile?: {
    name?: string;
  };
  charges_enabled: boolean;
  country: string;
  default_currency: string;
}

export class StripeAPIProvider {
  private baseUrl = 'https://api.stripe.com/v1';
  private apiVersion = '2023-10-16'; // Latest stable version

  constructor(private config: StripeConfig) {
    if (config.apiVersion) {
      this.apiVersion = config.apiVersion;
    }
  }

  /**
   * Hash API key to generate a unique identifier
   * Used for restricted keys where we can't get the real account ID
   */
  private async hashApiKey(apiKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(apiKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Validate API key and get account info
   * Works with both standard (sk_) and restricted (rk_) API keys
   *
   * For restricted keys, we use a minimal validation approach:
   * 1. Try /v1/account (requires rak_accounts_kyc_basic_read)
   * 2. If that fails, try listing 1 charge to validate read access
   */
  async validateAPIKey(apiKey: string): Promise<StripeAccountInfo> {
    console.log('[Stripe] Starting API key validation...');
    console.log('[Stripe] Key prefix:', apiKey.substring(0, 10) + '...');

    try {
      // First, try the full /v1/account endpoint (works with standard keys)
      console.log('[Stripe] Trying /v1/account endpoint...');
      const accountResponse = await fetch(`${this.baseUrl}/account`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Stripe-Version': this.apiVersion
        }
      });

      console.log('[Stripe] /v1/account response status:', accountResponse.status);

      if (accountResponse.ok) {
        // Standard key or restricted key with account permissions
        const account = await accountResponse.json() as {
          id: string;
          business_profile: any;
          charges_enabled: boolean;
          country: string;
          default_currency: string;
        };

        console.log('[Stripe] Account endpoint succeeded, account_id:', account.id);
        return {
          stripe_account_id: account.id,
          business_profile: account.business_profile,
          charges_enabled: account.charges_enabled,
          country: account.country,
          default_currency: account.default_currency
        };
      }

      // If /v1/account fails (likely restricted key), validate with charges endpoint
      structuredLog('WARN', 'Stripe account endpoint failed, trying charges validation for restricted key', { service: 'stripe-provider', status: accountResponse.status });

      console.log('[Stripe] Trying /v1/charges?limit=1 endpoint...');
      const chargesResponse = await fetch(`${this.baseUrl}/charges?limit=1`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Stripe-Version': this.apiVersion
        }
      });

      console.log('[Stripe] /v1/charges response status:', chargesResponse.status);

      if (!chargesResponse.ok) {
        const errorText = await chargesResponse.text();
        structuredLog('ERROR', 'Charges endpoint failed', { service: 'stripe', method: 'validateApiKey', error: errorText });
        throw new Error(`Invalid API key - cannot read charges (${chargesResponse.status}): ${errorText}`);
      }

      console.log('[Stripe] Charges endpoint succeeded, generating key hash...');
      // Key is valid for reading charges
      // Generate a unique account ID based on key hash for duplicate detection
      const keyHash = await this.hashApiKey(apiKey);
      console.log('[Stripe] Key hash generated:', keyHash.substring(0, 8) + '...');
      const keyParts = apiKey.split('_');
      const isLive = keyParts[1] === 'live';

      // Try to get minimal account info from balance endpoint (often allowed)
      let accountId = `acct_rk_${keyHash.substring(0, 16)}`;
      let currency = 'usd';
      let country = 'US';

      try {
        const balanceResponse = await fetch(`${this.baseUrl}/balance`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Stripe-Version': this.apiVersion
          }
        });

        if (balanceResponse.ok) {
          const balance = await balanceResponse.json() as {
            available: Array<{ currency: string }>;
            livemode: boolean;
          };
          if (balance.available?.[0]?.currency) {
            currency = balance.available[0].currency;
          }
        }
      } catch (e) {
        // Balance endpoint not available, use defaults
        console.log('Balance endpoint not available, using defaults');
      }

      console.log('[Stripe] Returning restricted key validation result:', { accountId, currency, country });
      return {
        stripe_account_id: accountId,
        business_profile: { name: 'Stripe Account (Restricted Key)' },
        charges_enabled: true, // If we can read charges, assume charges are enabled
        country: country,
        default_currency: currency
      };
    } catch (error) {
      structuredLog('ERROR', 'Validation failed', { service: 'stripe', method: 'validateApiKey', error: error instanceof Error ? error.message : String(error) });
      throw new Error(`Failed to validate Stripe API key: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Search charges using Stripe Search API
   * Supports metadata queries like: metadata["key"]:"value"
   */
  async searchCharges(
    searchQuery: string,
    options: {
      limit?: number;
      starting_after?: string;
      expand?: string[];
    } = {}
  ): Promise<StripeCharge[]> {
    const params = new URLSearchParams({
      query: searchQuery,
      limit: String(options.limit || 100)
    });

    if (options.starting_after) {
      params.append('starting_after', options.starting_after);
    }

    if (options.expand) {
      options.expand.forEach(field => params.append('expand[]', field));
    }

    const response = await fetch(`${this.baseUrl}/charges/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Stripe-Version': this.apiVersion
      }
    });

    if (!response.ok) {
      const errorData = await response.json() as { error?: { message?: string } };
      throw new Error(`Stripe search failed: ${errorData.error?.message || response.statusText}`);
    }

    const result = await response.json() as { data: StripeCharge[] };
    return result.data;
  }

  /**
   * List invoices to analyze billing_reason values
   * This is useful for understanding subscription patterns
   */
  async listInvoices(options: {
    limit?: number;
    starting_after?: string;
    created?: { gte?: number; lte?: number };
    expand?: string[];
  } = {}): Promise<Array<{
    id: string;
    customer: string;
    subscription: string | null;
    billing_reason: string | null;
    amount_paid: number;
    currency: string;
    status: string;
    created: number;
  }>> {
    const params = new URLSearchParams({
      limit: String(options.limit || 100)
    });

    if (options.starting_after) {
      params.append('starting_after', options.starting_after);
    }

    if (options.created?.gte) {
      params.append('created[gte]', String(options.created.gte));
    }

    if (options.created?.lte) {
      params.append('created[lte]', String(options.created.lte));
    }

    if (options.expand) {
      options.expand.forEach(field => params.append('expand[]', field));
    }

    const response = await fetch(`${this.baseUrl}/invoices?${params}`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Stripe-Version': this.apiVersion
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to list invoices: ${response.statusText}`);
    }

    const result = await response.json() as { data: any[] };
    return result.data.map((inv: any) => ({
      id: inv.id,
      customer: inv.customer,
      subscription: inv.subscription,
      billing_reason: inv.billing_reason,
      amount_paid: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      created: inv.created
    }));
  }

  /**
   * List charges with basic filtering (fallback when search isn't enough)
   */
  async listCharges(options: {
    limit?: number;
    starting_after?: string;
    created?: { gte?: number; lte?: number };
    customer?: string;
    expand?: string[];
  } = {}): Promise<StripeCharge[]> {
    const params = new URLSearchParams({
      limit: String(options.limit || 100)
    });

    if (options.starting_after) {
      params.append('starting_after', options.starting_after);
    }

    if (options.created?.gte) {
      params.append('created[gte]', String(options.created.gte));
    }

    if (options.created?.lte) {
      params.append('created[lte]', String(options.created.lte));
    }

    if (options.customer) {
      params.append('customer', options.customer);
    }

    if (options.expand) {
      options.expand.forEach(field => params.append('expand[]', field));
    }

    const response = await fetch(`${this.baseUrl}/charges?${params}`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Stripe-Version': this.apiVersion
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to list charges: ${response.statusText}`);
    }

    const result = await response.json() as { data: StripeCharge[] };
    return result.data;
  }

  /**
   * Fetch product details
   */
  async getProduct(productId: string): Promise<StripeProduct> {
    const response = await fetch(`${this.baseUrl}/products/${productId}`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Stripe-Version': this.apiVersion
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch product: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Fetch price details
   */
  async getPrice(priceId: string, expand?: string[]): Promise<StripePrice> {
    const params = new URLSearchParams();
    if (expand) {
      expand.forEach(field => params.append('expand[]', field));
    }

    const url = `${this.baseUrl}/prices/${priceId}${params.toString() ? `?${params}` : ''}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Stripe-Version': this.apiVersion
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch price: ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Build Stripe Search Query from filter rules
   * Converts our filter format to Stripe's search syntax
   */
  buildSearchQuery(filters: FilterRule[]): string {
    const clauses: string[] = [];

    for (const rule of filters) {
      const ruleClauses = this.buildRuleClauses(rule);
      if (ruleClauses.length > 0) {
        // Wrap in parentheses if combining with OR
        if (rule.operator === 'OR' && ruleClauses.length > 1) {
          clauses.push(`(${ruleClauses.join(' OR ')})`);
        } else {
          clauses.push(ruleClauses.join(` ${rule.operator} `));
        }
      }
    }

    return clauses.join(' AND ');
  }

  private buildRuleClauses(rule: FilterRule): string[] {
    const clauses: string[] = [];

    for (const condition of rule.conditions) {
      const clause = this.buildConditionClause(condition);
      if (clause) {
        clauses.push(clause);
      }
    }

    return clauses;
  }

  private buildConditionClause(condition: FilterCondition): string | null {
    // Handle metadata conditions
    if (condition.type === 'metadata') {
      return this.buildMetadataClause(condition);
    }

    // Handle standard field conditions
    switch (condition.field) {
      case 'amount':
        return this.buildNumericClause('amount', condition);
      case 'currency':
        return `currency:"${condition.value}"`;
      case 'status':
        return `status:"${condition.value}"`;
      case 'customer_id':
        return `customer:"${condition.value}"`;
      default:
        return null;
    }
  }

  private buildMetadataClause(condition: FilterCondition): string | null {
    const { metadata_key, operator, value } = condition;

    if (!metadata_key) return null;

    // Stripe Search API metadata syntax
    switch (operator) {
      case 'equals':
        return `metadata["${metadata_key}"]:"${value}"`;
      case 'not_equals':
        return `-metadata["${metadata_key}"]:"${value}"`;
      case 'exists':
        return `-metadata["${metadata_key}"]:null`;
      case 'not_exists':
        return `metadata["${metadata_key}"]:null`;
      default:
        // Some operators not supported by Stripe Search API
        // Will need client-side filtering
        return null;
    }
  }

  private buildNumericClause(field: string, condition: FilterCondition): string | null {
    const { operator, value } = condition;

    switch (operator) {
      case 'equals':
        return `${field}:${value}`;
      case 'gt':
        return `${field}>${value}`;
      case 'lt':
        return `${field}<${value}`;
      case 'gte':
        return `${field}>=${value}`;
      case 'lte':
        return `${field}<=${value}`;
      default:
        return null;
    }
  }

  /**
   * Fetch all pages of results
   */
  async fetchAllCharges(
    searchQuery: string,
    maxResults: number = 1000
  ): Promise<StripeCharge[]> {
    const allCharges: StripeCharge[] = [];
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore && allCharges.length < maxResults) {
      const batch = await this.searchCharges(searchQuery, {
        limit: Math.min(100, maxResults - allCharges.length),
        starting_after: startingAfter,
        expand: ['data.customer', 'data.invoice']
      });

      if (batch.length === 0) {
        hasMore = false;
      } else {
        allCharges.push(...batch);
        startingAfter = batch[batch.length - 1].id;
        hasMore = batch.length === 100;
      }
    }

    return allCharges;
  }

  /**
   * Expand products and prices for charges
   */
  async expandChargeData(charges: StripeCharge[]): Promise<Map<string, any>> {
    const expandedData = new Map();

    // Collect unique product and price IDs
    const productIds = new Set<string>();
    const priceIds = new Set<string>();

    for (const charge of charges) {
      if (charge.invoice_object?.lines?.data) {
        for (const line of charge.invoice_object.lines.data) {
          if (typeof line.price === 'string') {
            priceIds.add(line.price);
          } else if (line.price?.product) {
            if (typeof line.price.product === 'string') {
              productIds.add(line.price.product);
            }
          }
        }
      }
    }

    // Batch fetch products and prices
    const productPromises = Array.from(productIds).map(id =>
      this.getProduct(id).catch(err => {
        structuredLog('ERROR', 'Failed to fetch product', { service: 'stripe', method: 'enrichCharges', product_id: id, error: err instanceof Error ? err.message : String(err) });
        return null;
      })
    );

    const pricePromises = Array.from(priceIds).map(id =>
      this.getPrice(id, ['product']).catch(err => {
        structuredLog('ERROR', 'Failed to fetch price', { service: 'stripe', method: 'enrichCharges', price_id: id, error: err instanceof Error ? err.message : String(err) });
        return null;
      })
    );

    const [products, prices] = await Promise.all([
      Promise.all(productPromises),
      Promise.all(pricePromises)
    ]);

    // Store in map
    products.filter(p => p).forEach(product => {
      if (product) expandedData.set(`product:${product.id}`, product);
    });

    prices.filter(p => p).forEach(price => {
      if (price) expandedData.set(`price:${price.id}`, price);
    });

    return expandedData;
  }
}