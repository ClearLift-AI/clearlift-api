/**
 * Stripe Data Adapter
 *
 * Handles data transformation and storage for Stripe revenue data
 * Supports querying by arbitrary metadata fields
 */

import { StripeCharge, StripeProduct, StripePrice } from '../../services/providers/stripe';
import { MetadataSource } from '../../services/filters/types';

export interface StripeRevenueRecord {
  id: string;
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

  // Metadata as JSON strings
  charge_metadata?: string;
  product_metadata?: string;
  price_metadata?: string;
  customer_metadata?: string;

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

export class StripeAdapter {
  constructor(private db: D1Database) {}

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
      id: `${connectionId}_${charge.id}`,
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

      charge_metadata: JSON.stringify(charge.metadata || {}),
      product_metadata: JSON.stringify(productMetadata),
      price_metadata: JSON.stringify(priceMetadata),
      customer_metadata: JSON.stringify(charge.customer_object?.metadata || {}),

      units,
      net_amount: charge.amount, // TODO: Calculate after refunds
      fee_amount: undefined, // TODO: Get from balance transaction

      stripe_created_at: created.toISOString()
    };
  }

  /**
   * Store Stripe revenue record
   */
  async storeRevenueRecord(record: StripeRevenueRecord): Promise<void> {
    await this.db.prepare(`
      INSERT OR REPLACE INTO stripe_revenue_data (
        id, connection_id, organization_id, date,
        charge_id, payment_intent_id, invoice_id, subscription_id,
        product_id, price_id, customer_id,
        amount, currency, status, description,
        charge_metadata, product_metadata, price_metadata, customer_metadata,
        units, net_amount, fee_amount,
        stripe_created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, datetime('now')
      )
    `).bind(
      record.id,
      record.connection_id,
      record.organization_id,
      record.date,

      record.charge_id,
      record.payment_intent_id || null,
      record.invoice_id || null,
      record.subscription_id || null,

      record.product_id || null,
      record.price_id || null,
      record.customer_id || null,

      record.amount,
      record.currency,
      record.status,
      record.description || null,

      record.charge_metadata || '{}',
      record.product_metadata || '{}',
      record.price_metadata || '{}',
      record.customer_metadata || '{}',

      record.units,
      record.net_amount || null,
      record.fee_amount || null,

      record.stripe_created_at
    ).run();
  }

  /**
   * Query revenue data with metadata filters
   */
  async queryByMetadata(
    connectionId: string,
    filters: MetadataFilter[],
    dateRange?: { start: string; end: string }
  ): Promise<StripeRevenueRecord[]> {
    let sql = `SELECT * FROM stripe_revenue_data WHERE connection_id = ?`;
    const params: any[] = [connectionId];

    // Add date range filter
    if (dateRange) {
      sql += ` AND date >= ? AND date <= ?`;
      params.push(dateRange.start, dateRange.end);
    }

    // Add metadata filters
    for (const filter of filters) {
      const column = `${filter.source}_metadata`;
      const jsonPath = `$.${filter.key}`;

      switch (filter.operator) {
        case 'equals':
          sql += ` AND json_extract(${column}, ?) = ?`;
          params.push(jsonPath, filter.value);
          break;

        case 'not_equals':
          sql += ` AND json_extract(${column}, ?) != ?`;
          params.push(jsonPath, filter.value);
          break;

        case 'exists':
          sql += ` AND json_extract(${column}, ?) IS NOT NULL`;
          params.push(jsonPath);
          break;

        case 'not_exists':
          sql += ` AND json_extract(${column}, ?) IS NULL`;
          params.push(jsonPath);
          break;

        case 'contains':
          sql += ` AND json_extract(${column}, ?) LIKE ?`;
          params.push(jsonPath, `%${filter.value}%`);
          break;

        case 'gt':
          sql += ` AND CAST(json_extract(${column}, ?) AS REAL) > ?`;
          params.push(jsonPath, filter.value);
          break;

        case 'lt':
          sql += ` AND CAST(json_extract(${column}, ?) AS REAL) < ?`;
          params.push(jsonPath, filter.value);
          break;

        case 'in':
          if (Array.isArray(filter.value)) {
            const placeholders = filter.value.map(() => '?').join(',');
            sql += ` AND json_extract(${column}, ?) IN (${placeholders})`;
            params.push(jsonPath, ...filter.value);
          }
          break;
      }
    }

    sql += ` ORDER BY date DESC, stripe_created_at DESC`;

    const result = await this.db.prepare(sql).bind(...params).all();
    return result.results as StripeRevenueRecord[];
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
    // Sample data to extract keys
    const samples = await this.db.prepare(`
      SELECT
        charge_metadata,
        product_metadata,
        price_metadata,
        customer_metadata
      FROM stripe_revenue_data
      WHERE connection_id = ?
      LIMIT 1000
    `).bind(connectionId).all();

    const keysBySource: Record<string, Set<string>> = {
      charge: new Set(),
      product: new Set(),
      price: new Set(),
      customer: new Set()
    };

    for (const row of samples.results || []) {
      for (const source of ['charge', 'product', 'price', 'customer']) {
        const metadata = row[`${source}_metadata` as keyof typeof row];
        if (metadata) {
          try {
            const parsed = JSON.parse(metadata as string);
            this.extractKeys(parsed, keysBySource[source]);
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    // Also update the metadata keys cache
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
    const statements: string[] = [];
    const params: any[][] = [];

    for (const [source, keys] of Object.entries(keysBySource)) {
      for (const key of keys) {
        statements.push(`
          INSERT INTO stripe_metadata_keys (
            id, connection_id, object_type, key_path, value_type, last_seen
          ) VALUES (?, ?, ?, ?, 'string', datetime('now'))
          ON CONFLICT(connection_id, object_type, key_path) DO UPDATE
          SET last_seen = datetime('now'),
              occurrence_count = occurrence_count + 1
        `);
        params.push([`${connectionId}_${source}_${key}`, connectionId, source, key]);
      }
    }

    // Batch insert/update
    for (let i = 0; i < statements.length; i++) {
      await this.db.prepare(statements[i]).bind(...params[i]).run();
    }
  }

  /**
   * Create daily aggregates
   */
  async createDailyAggregates(
    connectionId: string,
    date: string
  ): Promise<DailyAggregate> {
    // Get all transactions for the day
    const transactions = await this.db.prepare(`
      SELECT * FROM stripe_revenue_data
      WHERE connection_id = ? AND date = ?
    `).bind(connectionId, date).all();

    const aggregate: DailyAggregate = {
      date,
      currency: 'usd', // TODO: Support multiple currencies
      total_revenue: 0,
      total_units: 0,
      transaction_count: 0,
      unique_customers: new Set<string>().size,
      revenue_by_product: {},
      revenue_by_status: {},
      top_metadata_values: {}
    };

    const customerSet = new Set<string>();
    const metadataValueCounts: Record<string, Record<string, number>> = {};

    for (const tx of transactions.results || []) {
      // Only count successful charges
      if (tx.status === 'succeeded') {
        aggregate.total_revenue += tx.amount;
        aggregate.total_units += tx.units || 1;
      }

      aggregate.transaction_count++;

      if (tx.customer_id) {
        customerSet.add(tx.customer_id);
      }

      // Group by product
      if (tx.product_id) {
        aggregate.revenue_by_product[tx.product_id] =
          (aggregate.revenue_by_product[tx.product_id] || 0) + tx.amount;
      }

      // Group by status
      aggregate.revenue_by_status[tx.status] =
        (aggregate.revenue_by_status[tx.status] || 0) + tx.amount;

      // Track metadata value frequencies
      this.trackMetadataValues(tx, metadataValueCounts);
    }

    aggregate.unique_customers = customerSet.size;

    // Get top 5 values for each metadata key
    aggregate.top_metadata_values = this.getTopMetadataValues(metadataValueCounts, 5);

    // Store the aggregate
    await this.storeDailyAggregate(connectionId, aggregate);

    return aggregate;
  }

  private trackMetadataValues(
    record: any,
    counts: Record<string, Record<string, number>>
  ): void {
    const sources = ['charge', 'product', 'price'];

    for (const source of sources) {
      const metadata = record[`${source}_metadata`];
      if (!metadata) continue;

      try {
        const parsed = JSON.parse(metadata);
        for (const [key, value] of Object.entries(parsed)) {
          const countKey = `${source}.${key}`;
          if (!counts[countKey]) {
            counts[countKey] = {};
          }
          const strValue = String(value);
          counts[countKey][strValue] = (counts[countKey][strValue] || 0) + 1;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  private getTopMetadataValues(
    counts: Record<string, Record<string, number>>,
    limit: number
  ): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};

    for (const [key, valueCounts] of Object.entries(counts)) {
      // Sort by count and take top N
      const sorted = Object.entries(valueCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

      result[key] = Object.fromEntries(sorted);
    }

    return result;
  }

  private async storeDailyAggregate(
    connectionId: string,
    aggregate: DailyAggregate
  ): Promise<void> {
    const org = await this.db.prepare(`
      SELECT organization_id FROM platform_connections WHERE id = ?
    `).bind(connectionId).first();

    if (!org) return;

    await this.db.prepare(`
      INSERT OR REPLACE INTO stripe_daily_aggregates (
        id, connection_id, organization_id, date, currency,
        total_revenue, total_units, transaction_count, unique_customers,
        revenue_by_product, revenue_by_status, top_metadata_values,
        updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        datetime('now')
      )
    `).bind(
      `${connectionId}_${aggregate.date}_${aggregate.currency}`,
      connectionId,
      org.organization_id,
      aggregate.date,
      aggregate.currency,
      aggregate.total_revenue,
      aggregate.total_units,
      aggregate.transaction_count,
      aggregate.unique_customers,
      JSON.stringify(aggregate.revenue_by_product),
      JSON.stringify(aggregate.revenue_by_status),
      JSON.stringify(aggregate.top_metadata_values)
    ).run();
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
    await this.db.prepare(`
      INSERT INTO stripe_sync_state (
        connection_id, last_charge_id, last_sync_timestamp,
        next_sync_from, total_charges_synced, total_revenue_synced
      ) VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        last_charge_id = excluded.last_charge_id,
        last_sync_timestamp = datetime('now'),
        next_sync_from = datetime('now'),
        total_charges_synced = total_charges_synced + excluded.total_charges_synced,
        total_revenue_synced = total_revenue_synced + excluded.total_revenue_synced
    `).bind(connectionId, lastChargeId, chargeCount, totalRevenue).run();
  }
}