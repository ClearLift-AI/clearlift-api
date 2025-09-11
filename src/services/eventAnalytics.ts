export interface ConversionEvent {
  id: string;
  organization_id: string;
  event_id: string;
  timestamp: string;
  event_type: string;
  event_value: number;
  currency: string;
  user_id: string;
  session_id: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  device_type?: string;
  browser?: string;
  country?: string;
  attribution_path?: string;
}

export interface EventMetrics {
  period: string;
  event_type: string;
  event_count: number;
  total_value: number;
  avg_value: number;
  unique_users: number;
}

export class EventAnalyticsService {
  private containerBinding: any;
  private organizationId: string;

  constructor(containerBinding: any, organizationId: string) {
    this.containerBinding = containerBinding;
    this.organizationId = organizationId;
  }

  /**
   * Get a DuckLake container instance for this organization
   */
  private getContainerInstance() {
    // Use organization ID as the container instance ID for isolation
    return this.containerBinding.get(this.containerBinding.idFromName(this.organizationId));
  }

  /**
   * Execute a DuckDB query via the DuckLake container
   */
  async executeQuery(query: string): Promise<any> {
    const container = this.getContainerInstance();
    
    const response = await container.fetch(new Request('http://ducklake/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.organizationId}` // Use org ID as auth token for now
      },
      body: JSON.stringify({ query })
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DuckLake query failed: ${error}`);
    }

    const result = await response.json();
    return result.data;
  }

  /**
   * Get conversion events from R2 Data Catalog
   */
  async getConversionEvents(params: {
    start_date?: string;
    end_date?: string;
    event_types?: string[];
    limit?: number;
  }): Promise<ConversionEvent[]> {
    const { start_date, end_date, event_types, limit = 1000 } = params;

    let whereConditions = [`organization_id = '${this.organizationId}'`];
    
    if (start_date) {
      whereConditions.push(`timestamp >= '${start_date}'`);
    }
    
    if (end_date) {
      whereConditions.push(`timestamp <= '${end_date}'`);
    }
    
    if (event_types && event_types.length > 0) {
      const types = event_types.map(t => `'${t}'`).join(', ');
      whereConditions.push(`event_type IN (${types})`);
    }

    const query = `
      SELECT 
        id,
        organization_id,
        event_id,
        timestamp,
        event_type,
        event_value,
        currency,
        user_id,
        session_id,
        utm_source,
        utm_medium,
        utm_campaign,
        device_type,
        browser,
        country,
        attribution_path
      FROM r2_catalog.default.conversion_events
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    try {
      return await this.executeQuery(query);
    } catch (error) {
      // If table doesn't exist yet, return empty array
      if (error.message.includes('does not exist')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get aggregated conversion metrics
   */
  async getConversionMetrics(params: {
    start_date?: string;
    end_date?: string;
    group_by?: 'hour' | 'day' | 'week' | 'month';
  }): Promise<EventMetrics[]> {
    const { start_date, end_date, group_by = 'day' } = params;

    const container = this.getContainerInstance();
    
    const response = await container.fetch(new Request('http://ducklake/events/conversions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        organization_id: this.organizationId,
        start_date,
        end_date,
        group_by
      })
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get conversion metrics: ${error}`);
    }

    const result = await response.json();
    return result.data || [];
  }

  /**
   * Get event-based insights using DuckDB analytics
   */
  async getEventInsights(params: {
    start_date?: string;
    end_date?: string;
    metric_type?: 'conversion_rate' | 'revenue' | 'user_journey';
  }): Promise<any> {
    const { start_date, end_date, metric_type = 'conversion_rate' } = params;

    let query: string;

    switch (metric_type) {
      case 'conversion_rate':
        query = `
          SELECT 
            DATE_TRUNC('day', timestamp) as date,
            event_type,
            COUNT(*) as conversions,
            COUNT(DISTINCT user_id) as unique_users,
            ROUND(COUNT(*) * 100.0 / COUNT(DISTINCT session_id), 2) as conversion_rate
          FROM r2_catalog.default.conversion_events
          WHERE organization_id = '${this.organizationId}'
            ${start_date ? `AND timestamp >= '${start_date}'` : ''}
            ${end_date ? `AND timestamp <= '${end_date}'` : ''}
          GROUP BY date, event_type
          ORDER BY date DESC
        `;
        break;

      case 'revenue':
        query = `
          SELECT 
            DATE_TRUNC('day', timestamp) as date,
            event_type,
            SUM(event_value) as total_revenue,
            AVG(event_value) as avg_order_value,
            MAX(event_value) as max_order_value,
            COUNT(*) as transaction_count
          FROM r2_catalog.default.conversion_events
          WHERE organization_id = '${this.organizationId}'
            AND event_value > 0
            ${start_date ? `AND timestamp >= '${start_date}'` : ''}
            ${end_date ? `AND timestamp <= '${end_date}'` : ''}
          GROUP BY date, event_type
          ORDER BY date DESC
        `;
        break;

      case 'user_journey':
        query = `
          WITH user_events AS (
            SELECT 
              user_id,
              event_type,
              timestamp,
              LAG(event_type) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_event,
              LEAD(event_type) OVER (PARTITION BY user_id ORDER BY timestamp) as next_event
            FROM r2_catalog.default.conversion_events
            WHERE organization_id = '${this.organizationId}'
              ${start_date ? `AND timestamp >= '${start_date}'` : ''}
              ${end_date ? `AND timestamp <= '${end_date}'` : ''}
          )
          SELECT 
            prev_event || ' -> ' || event_type as transition,
            COUNT(*) as occurrences,
            COUNT(DISTINCT user_id) as unique_users
          FROM user_events
          WHERE prev_event IS NOT NULL
          GROUP BY transition
          ORDER BY occurrences DESC
          LIMIT 20
        `;
        break;

      default:
        throw new Error(`Unknown metric type: ${metric_type}`);
    }

    try {
      return await this.executeQuery(query);
    } catch (error) {
      // If table doesn't exist yet, return empty result
      if (error.message.includes('does not exist')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Write conversion events to R2 as Iceberg tables
   * This would typically be done via a separate data pipeline,
   * but we can provide a method to write events via DuckDB
   */
  async writeConversionEvents(events: ConversionEvent[]): Promise<void> {
    if (events.length === 0) return;

    // First, create the table if it doesn't exist
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS r2_catalog.default.conversion_events (
        id VARCHAR,
        organization_id VARCHAR,
        event_id VARCHAR,
        timestamp TIMESTAMP,
        event_type VARCHAR,
        event_value DOUBLE,
        currency VARCHAR,
        user_id VARCHAR,
        session_id VARCHAR,
        utm_source VARCHAR,
        utm_medium VARCHAR,
        utm_campaign VARCHAR,
        device_type VARCHAR,
        browser VARCHAR,
        country VARCHAR,
        attribution_path VARCHAR
      )
    `;

    try {
      await this.executeQuery(createTableQuery);
    } catch (error) {
      // Table might already exist, continue
      console.warn('Table creation warning:', error.message);
    }

    // Insert events in batches
    const batchSize = 100;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      
      const values = batch.map(event => `(
        '${event.id}',
        '${event.organization_id}',
        '${event.event_id}',
        '${event.timestamp}',
        '${event.event_type}',
        ${event.event_value},
        '${event.currency}',
        '${event.user_id}',
        '${event.session_id}',
        ${event.utm_source ? `'${event.utm_source}'` : 'NULL'},
        ${event.utm_medium ? `'${event.utm_medium}'` : 'NULL'},
        ${event.utm_campaign ? `'${event.utm_campaign}'` : 'NULL'},
        ${event.device_type ? `'${event.device_type}'` : 'NULL'},
        ${event.browser ? `'${event.browser}'` : 'NULL'},
        ${event.country ? `'${event.country}'` : 'NULL'},
        ${event.attribution_path ? `'${event.attribution_path}'` : 'NULL'}
      )`).join(',\n');

      const insertQuery = `
        INSERT INTO r2_catalog.default.conversion_events
        VALUES ${values}
      `;

      await this.executeQuery(insertQuery);
    }
  }
}