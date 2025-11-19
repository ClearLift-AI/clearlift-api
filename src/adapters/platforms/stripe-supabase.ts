/**
 * Stripe Data Adapter for Supabase
 *
 * Handles data transformation and storage for Stripe revenue data in Supabase
 * Supports querying by arbitrary metadata fields using JSONB
 */

import { SupabaseClient } from '../../services/supabase';
import { StripeCharge, StripeProduct, StripePrice } from '../../services/providers/stripe';
import { MetadataSource } from '../../services/filters/types';

export interface StripeRevenueRecord {
  id?: string;
  connection_id: string;
  organization_id: string;
  date: string;

  // Stripe IDs
  charge_id: string;
  payment_intent_id?: string;
  invoice_id?: string;
  subscription_id?: string;
  product_id?: string;
  price_id?: string;
  customer_id?: string;

  // Financial data
  amount: number;
  currency: string;
  status: string;
  description?: string;

  // Metadata as JSONB
  charge_metadata: any;
  product_metadata: any;
  price_metadata: any;
  customer_metadata: any;

  // Calculated
  units: number;
  net_amount?: number;
  fee_amount?: number;

  stripe_created_at: string;
}

export interface DailyAggregate {
  date: string;
  currency: string;
  total_revenue: number;
  total_units: number;
  transaction_count: number;
  unique_customers: number;
  revenue_by_product: Record<string, number>;
  revenue_by_status: Record<string, number>;
  top_metadata_values: Record<string, Record<string, number>>;
}

export interface MetadataFilter {
  source: MetadataSource;
  key: string;
  operator: string;
  value: any;
}

export class StripeSupabaseAdapter {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Transform Stripe charge to internal format
   */
  transformCharge(
    charge: StripeCharge,
    connectionId: string,
    organizationId: string,
    expandedData?: Map<string, any>
  ): StripeRevenueRecord {
    // Extract product and price from invoice if available
    let productId: string | undefined;
    let priceId: string | undefined;
    let productMetadata: any = {};
    let priceMetadata: any = {};
    let units = 1;

    if (charge.invoice_object?.lines?.data?.[0]) {
      const line = charge.invoice_object.lines.data[0];
      units = line.quantity || 1;

      if (typeof line.price === 'string') {
        priceId = line.price;
        // Look up expanded price data
        const priceData = expandedData?.get(`price:${priceId}`);
        if (priceData) {
          priceMetadata = priceData.metadata || {};
          if (typeof priceData.product === 'string') {
            productId = priceData.product;
          }
        }
      } else if (line.price) {
        priceId = line.price.id;
        priceMetadata = line.price.metadata || {};
        if (typeof line.price.product === 'string') {
          productId = line.price.product;
        } else if (line.price.product) {
          productId = line.price.product.id;
          productMetadata = line.price.product.metadata || {};
        }
      }
    }

    // Look up expanded product data if we have ID but no metadata
    if (productId && Object.keys(productMetadata).length === 0) {
      const productData = expandedData?.get(`product:${productId}`);
      if (productData) {
        productMetadata = productData.metadata || {};
      }
    }

    const created = new Date(charge.created * 1000);

    return {
      connection_id: connectionId,
      organization_id: organizationId,
      date: created.toISOString().split('T')[0],

      charge_id: charge.id,
      payment_intent_id: charge.payment_intent,
      invoice_id: charge.invoice,
      subscription_id: charge.invoice_object?.subscription,
      product_id: productId,
      price_id: priceId,
      customer_id: charge.customer,

      amount: charge.amount,
      currency: charge.currency,
      status: charge.status,
      description: charge.description,

      // Store as JSONB objects, not strings
      charge_metadata: charge.metadata || {},
      product_metadata: productMetadata,
      price_metadata: priceMetadata,
      customer_metadata: charge.customer_object?.metadata || {},

      units,
      net_amount: charge.amount, // TODO: Calculate after refunds
      fee_amount: undefined, // TODO: Get from balance transaction

      stripe_created_at: created.toISOString()
    };
  }

  /**
   * Store Stripe revenue records in batch
   */
  async storeRevenueRecords(records: StripeRevenueRecord[]): Promise<void> {
    if (records.length === 0) return;

    // Batch insert for better performance
    await this.supabase.batchInsert('stripe_conversions', records, 500);
  }

  /**
   * Store single revenue record
   */
  async storeRevenueRecord(record: StripeRevenueRecord): Promise<void> {
    await this.supabase.upsert('stripe_conversions', record, {
      onConflict: 'charge_id',
      returning: false
    });
  }

  /**
   * Query revenue data with metadata filters using JSONB operators
   */
  async queryByMetadata(
    connectionId: string,
    filters: MetadataFilter[],
    dateRange?: { start: string; end: string }
  ): Promise<StripeRevenueRecord[]> {
    // Extract organization_id from connection_id (format: {uuid}-platform-accountid)
    // Connection format: ff013ed0-a4d6-4d64-a21e-bcfc2b0bb757-stripe-ch
    // Organization ID is the UUID (first 5 parts when split by hyphen)
    const parts = connectionId.split('-');
    const orgId = parts.slice(0, 5).join('-');  // Reconstruct UUID from first 5 parts

    // Build URL params directly
    const params = new URLSearchParams();
    params.append('organization_id', `eq.${orgId}`);
    params.append('payment_status', 'eq.succeeded'); // Only succeeded payments

    // Add date range filter using stripe_created_at
    if (dateRange) {
      params.append('stripe_created_at', `gte.${dateRange.start}T00:00:00Z`);
      params.append('stripe_created_at', `lte.${dateRange.end}T23:59:59Z`);
    }

    params.append('limit', '10000');

    // Query stripe.payment_intents table (using stripe schema)
    const endpoint = `payment_intents?${params.toString()}`;
    const results = await this.supabase.queryWithSchema<any[]>(endpoint, 'stripe', { method: 'GET' });

    // Transform payment_intents records to StripeRevenueRecord format
    const transformedResults: StripeRevenueRecord[] = (results || []).map(row => {
      // Extract metadata from JSONB field
      const metadata = row.metadata || {};
      const rawData = row.raw_data || {};

      return {
        id: row.id,
        connection_id: connectionId,
        organization_id: orgId,
        date: row.stripe_created_at ? row.stripe_created_at.split('T')[0] : '',

        // Primary identifiers
        charge_id: row.payment_intent_id, // Using payment_intent_id as charge_id
        payment_intent_id: row.payment_intent_id,
        invoice_id: row.invoice_id,
        subscription_id: rawData.subscription,
        product_id: metadata.product_id,
        price_id: metadata.price_id,
        customer_id: row.customer_id,

        // Financial data
        amount: row.amount_cents || 0,
        currency: row.currency || 'usd',
        status: row.payment_status || 'unknown',
        description: rawData.description,

        // Metadata from JSONB
        charge_metadata: metadata || {},
        product_metadata: metadata.product || {},
        price_metadata: metadata.price || {},
        customer_metadata: metadata.customer || {},

        units: metadata.quantity || 1,
        net_amount: row.amount_cents || 0,
        fee_amount: rawData.fee_amount,

        stripe_created_at: row.stripe_created_at
      };
    });

    // Apply client-side filters for unsupported operations
    return this.applyClientSideFilters(transformedResults, filters);
  }

  private applyClientSideFilters(
    records: StripeRevenueRecord[],
    filters: MetadataFilter[]
  ): StripeRevenueRecord[] {
    return records.filter(record => {
      for (const filter of filters) {
        const metadata = (record as any)[`${filter.source}_metadata`];
        if (!metadata) continue;

        const value = this.getNestedValue(metadata, filter.key);

        switch (filter.operator) {
          case 'not_exists':
            if (value !== undefined) return false;
            break;

          case 'not_equals':
            if (value === filter.value) return false;
            break;

          case 'contains':
            if (!String(value).includes(String(filter.value))) return false;
            break;

          case 'gt':
            if (!(Number(value) > Number(filter.value))) return false;
            break;

          case 'lt':
            if (!(Number(value) < Number(filter.value))) return false;
            break;

          case 'in':
            if (!Array.isArray(filter.value) || !filter.value.includes(value)) return false;
            break;
        }
      }
      return true;
    });
  }

  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * Get unique metadata keys from existing data
   */
  async getMetadataKeys(connectionId: string): Promise<{
    charge: string[];
    product: string[];
    price: string[];
    customer: string[];
  }> {
    // Extract organization_id from connection_id
    const parts = connectionId.split('-');
    const orgId = parts.slice(0, 5).join('-');

    // Query samples from stripe.payment_intents
    const params = new URLSearchParams();
    params.append('organization_id', `eq.${orgId}`);
    params.append('select', 'metadata,raw_data');
    params.append('limit', '1000');

    const endpoint = `payment_intents?${params.toString()}`;
    const samples = await this.supabase.queryWithSchema<any[]>(endpoint, 'stripe', { method: 'GET' }) || [];

    const keysBySource: Record<string, Set<string>> = {
      charge: new Set(),
      product: new Set(),
      price: new Set(),
      customer: new Set()
    };

    for (const row of samples) {
      const metadata = row.metadata || {};
      const rawData = row.raw_data || {};

      // Extract keys from metadata (charge-level metadata)
      if (metadata && typeof metadata === 'object') {
        this.extractKeys(metadata, keysBySource.charge);
      }

      // Extract product/price/customer keys from metadata JSONB
      if (metadata.product && typeof metadata.product === 'object') {
        this.extractKeys(metadata.product, keysBySource.product);
      }
      if (metadata.price && typeof metadata.price === 'object') {
        this.extractKeys(metadata.price, keysBySource.price);
      }
      if (metadata.customer && typeof metadata.customer === 'object') {
        this.extractKeys(metadata.customer, keysBySource.customer);
      }
    }

    return {
      charge: Array.from(keysBySource.charge),
      product: Array.from(keysBySource.product),
      price: Array.from(keysBySource.price),
      customer: Array.from(keysBySource.customer)
    };
  }

  private extractKeys(obj: any, keys: Set<string>, prefix = ''): void {
    if (!obj || typeof obj !== 'object') return;

    for (const key in obj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      keys.add(fullKey);

      // Recursively extract nested keys
      if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
        this.extractKeys(obj[key], keys, fullKey);
      }
    }
  }

  private async updateMetadataKeysCache(
    connectionId: string,
    keysBySource: Record<string, Set<string>>
  ): Promise<void> {
    const records: any[] = [];

    for (const [source, keys] of Object.entries(keysBySource)) {
      for (const key of keys) {
        records.push({
          connection_id: connectionId,
          object_type: source,
          key_path: key,
          value_types: ['string'], // Simplified for now
          last_seen: new Date().toISOString()
        });
      }
    }

    if (records.length > 0) {
      await this.supabase.upsert('stripe_metadata_keys', records, {
        onConflict: 'connection_id,object_type,key_path',
        returning: false
      });
    }
  }

  /**
   * Get daily aggregates for a date range
   */
  async getDailyAggregates(
    connectionId: string,
    dateRange: { start: string; end: string },
    currency?: string
  ): Promise<any[]> {
    // Extract organization_id from connection_id
    const parts = connectionId.split('-');
    const orgId = parts.slice(0, 5).join('-');

    // Query stripe.payment_intents directly and aggregate in-memory
    const params = new URLSearchParams();
    params.append('organization_id', `eq.${orgId}`);
    params.append('stripe_created_at', `gte.${dateRange.start}T00:00:00Z`);
    params.append('stripe_created_at', `lte.${dateRange.end}T23:59:59Z`);
    params.append('payment_status', 'eq.succeeded');

    if (currency) {
      params.append('currency', `eq.${currency}`);
    }

    params.append('limit', '10000');

    // Query stripe.payment_intents table (using stripe schema)
    const endpoint = `payment_intents?${params.toString()}`;

    try {
      // Use the queryWithSchema method to query the stripe schema
      const records = await this.supabase.queryWithSchema<any[]>(endpoint, 'stripe', {
        method: 'GET'
      });

      // Group by date and aggregate
      const dailyMap = new Map<string, any>();

      records.forEach((row: any) => {
        const date = row.stripe_created_at.split('T')[0];

        if (!dailyMap.has(date)) {
          dailyMap.set(date, {
            date,
            currency: row.currency,
            total_revenue: 0,
            total_units: 0,
            transaction_count: 0,
            unique_customers: new Set()
          });
        }

        const daily = dailyMap.get(date)!;
        daily.total_revenue += row.amount_cents || 0;
        daily.total_units += 1; // Each payment intent is 1 unit
        daily.transaction_count += 1;

        if (row.customer_id) {
          daily.unique_customers.add(row.customer_id);
        }
      });

      // Convert to array and finalize
      return Array.from(dailyMap.values())
        .map(daily => ({
          date: daily.date,
          currency: daily.currency,
          total_revenue: daily.total_revenue,
          total_units: daily.total_units,
          transaction_count: daily.transaction_count,
          unique_customers: daily.unique_customers.size,
          revenue_by_product: {},
          revenue_by_status: {},
          top_metadata_values: {}
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch (error) {
      console.error('Failed to get daily aggregates:', error);
      return [];
    }
  }

  /**
   * Create daily aggregates using Supabase RPC
   */
  async createDailyAggregates(
    connectionId: string,
    date: string
  ): Promise<DailyAggregate | null> {
    try {
      // Call the PostgreSQL function
      await this.supabase.rpc('calculate_stripe_daily_aggregate', {
        p_connection_id: connectionId,
        p_date: date
      });

      // Fetch the created aggregate
      const aggregates = await this.supabase.select<any>(
        'stripe_daily_aggregates',
        `connection_id.eq.${connectionId}&date.eq.${date}`,
        { limit: 1 }
      );

      if (aggregates.length > 0) {
        return this.transformAggregate(aggregates[0]);
      }

      return null;
    } catch (error) {
      console.error('Failed to create daily aggregate:', error);
      return null;
    }
  }

  private transformAggregate(row: any): DailyAggregate {
    return {
      date: row.date,
      currency: row.currency,
      total_revenue: row.total_revenue,
      total_units: row.total_units,
      transaction_count: row.transaction_count,
      unique_customers: row.unique_customers,
      revenue_by_product: row.revenue_by_product || {},
      revenue_by_status: row.revenue_by_status || {},
      top_metadata_values: row.top_metadata_values || {}
    };
  }

  /**
   * Update sync state
   */
  async updateSyncState(
    connectionId: string,
    lastChargeId: string,
    chargeCount: number,
    totalRevenue: number
  ): Promise<void> {
    const state = {
      connection_id: connectionId,
      last_charge_id: lastChargeId,
      last_sync_timestamp: new Date().toISOString(),
      next_sync_from: new Date().toISOString(),
      total_charges_synced: chargeCount,
      total_revenue_synced: totalRevenue
    };

    await this.supabase.upsert('stripe_sync_state', state, {
      onConflict: 'connection_id',
      returning: false
    });
  }

  /**
   * Get sync state
   */
  async getSyncState(connectionId: string): Promise<any> {
    const results = await this.supabase.select(
      'stripe_sync_state',
      `connection_id.eq.${connectionId}`,
      { limit: 1 }
    );

    return results[0] || null;
  }

  /**
   * Store filter rules
   */
  async storeFilterRule(rule: any): Promise<string> {
    const result = await this.supabase.insert(
      'connector_filter_rules',
      rule,
      { returning: true }
    );

    return result[0]?.id;
  }

  /**
   * Get filter rules
   */
  async getFilterRules(connectionId: string, activeOnly = true): Promise<any[]> {
    let query = `connection_id.eq.${connectionId}`;
    if (activeOnly) {
      query += '&is_active.eq.true';
    }

    return await this.supabase.select(
      'connector_filter_rules',
      query,
      { order: 'created_at.desc' }
    );
  }

  /**
   * Update filter rule
   */
  async updateFilterRule(filterId: string, updates: any): Promise<void> {
    await this.supabase.update(
      'connector_filter_rules',
      updates,
      `id.eq.${filterId}`
    );
  }

  /**
   * Delete filter rule
   */
  async deleteFilterRule(filterId: string): Promise<void> {
    await this.supabase.delete(
      'connector_filter_rules',
      `id.eq.${filterId}`
    );
  }
}