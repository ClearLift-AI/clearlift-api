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
    await this.supabase.batchInsert('stripe_revenue_data', records, 500);
  }

  /**
   * Store single revenue record
   */
  async storeRevenueRecord(record: StripeRevenueRecord): Promise<void> {
    await this.supabase.upsert('stripe_revenue_data', record, {
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
    // Build filter string for Supabase
    const filterParts: string[] = [`connection_id.eq.${connectionId}`];

    // Add date range filter
    if (dateRange) {
      filterParts.push(`date.gte.${dateRange.start}`);
      filterParts.push(`date.lte.${dateRange.end}`);
    }

    // Build JSONB filters
    const jsonbFilters = filters.map(filter => {
      const column = `${filter.source}_metadata`;

      switch (filter.operator) {
        case 'equals':
          return {
            column,
            operator: 'contains' as const,
            value: { [filter.key]: filter.value }
          };

        case 'exists':
          return {
            column,
            operator: 'has_key' as const,
            value: filter.key
          };

        case 'not_exists':
          // This requires a workaround - we'll filter client-side
          return null;

        case 'contains':
          // For partial string matching, need client-side filtering
          return null;

        default:
          return null;
      }
    }).filter(Boolean);

    // Query with JSONB filters
    let results: StripeRevenueRecord[];

    if (jsonbFilters.length > 0) {
      results = await this.supabase.queryJsonb<StripeRevenueRecord>(
        'stripe_revenue_data',
        jsonbFilters as any,
        { limit: 10000 }
      );
    } else {
      // Regular query without JSONB filters
      const query = filterParts.join('&');
      results = await this.supabase.select<StripeRevenueRecord>(
        'stripe_revenue_data',
        query,
        { limit: 10000 }
      );
    }

    // Apply client-side filters for unsupported operations
    return this.applyClientSideFilters(results, filters);
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
    // Use Supabase RPC function if available, or query samples
    const samples = await this.supabase.select<any>(
      'stripe_revenue_data',
      `connection_id.eq.${connectionId}`,
      {
        select: 'charge_metadata,product_metadata,price_metadata,customer_metadata',
        limit: 1000
      }
    );

    const keysBySource: Record<string, Set<string>> = {
      charge: new Set(),
      product: new Set(),
      price: new Set(),
      customer: new Set()
    };

    for (const row of samples) {
      for (const source of ['charge', 'product', 'price', 'customer']) {
        const metadata = row[`${source}_metadata`];
        if (metadata && typeof metadata === 'object') {
          this.extractKeys(metadata, keysBySource[source]);
        }
      }
    }

    // Update metadata keys cache
    await this.updateMetadataKeysCache(connectionId, keysBySource);

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