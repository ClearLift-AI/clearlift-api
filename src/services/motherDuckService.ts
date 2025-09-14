import { ConversionEvent } from './eventAnalytics';

export interface MotherDuckConfig {
  token: string;
  database?: string;
}

export class MotherDuckService {
  private token: string;
  private database: string;
  private baseUrl = 'https://api.motherduck.com/v1';

  constructor(config: MotherDuckConfig) {
    this.token = config.token;
    this.database = config.database || 'clearlift';
  }

  /**
   * Execute a SQL query via MotherDuck REST API
   */
  async executeQuery(query: string): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          database: this.database
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`MotherDuck query failed: ${error}`);
      }

      const result = await response.json();
      return result.data || [];
    } catch (error) {
      console.error('MotherDuck query error:', error);
      throw error;
    }
  }

  /**
   * Write conversion events to R2 via MotherDuck
   */
  async writeConversionEvents(events: ConversionEvent[]): Promise<void> {
    if (events.length === 0) return;

    // First, ensure the table exists in MotherDuck with R2 backing
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS conversion_events (
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
      );
    `;

    try {
      await this.executeQuery(createTableQuery);
    } catch (error) {
      console.warn('Table creation warning:', error);
    }

    // Insert events in batches
    const batchSize = 100;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      
      const values = batch.map(event => `(
        '${this.escapeString(event.id)}',
        '${this.escapeString(event.organization_id)}',
        '${this.escapeString(event.event_id)}',
        '${event.timestamp}',
        '${this.escapeString(event.event_type)}',
        ${event.event_value},
        '${this.escapeString(event.currency)}',
        '${this.escapeString(event.user_id)}',
        '${this.escapeString(event.session_id)}',
        ${event.utm_source ? `'${this.escapeString(event.utm_source)}'` : 'NULL'},
        ${event.utm_medium ? `'${this.escapeString(event.utm_medium)}'` : 'NULL'},
        ${event.utm_campaign ? `'${this.escapeString(event.utm_campaign)}'` : 'NULL'},
        ${event.device_type ? `'${this.escapeString(event.device_type)}'` : 'NULL'},
        ${event.browser ? `'${this.escapeString(event.browser)}'` : 'NULL'},
        ${event.country ? `'${this.escapeString(event.country)}'` : 'NULL'},
        ${event.attribution_path ? `'${this.escapeString(event.attribution_path)}'` : 'NULL'}
      )`).join(',\n');

      const insertQuery = `
        INSERT INTO conversion_events
        VALUES ${values};
      `;

      await this.executeQuery(insertQuery);
    }
  }

  /**
   * Get conversion events from MotherDuck
   */
  async getConversionEvents(params: {
    organization_id: string;
    start_date?: string;
    end_date?: string;
    event_types?: string[];
    limit?: number;
  }): Promise<ConversionEvent[]> {
    const { organization_id, start_date, end_date, event_types, limit = 1000 } = params;

    let whereConditions = [`organization_id = '${this.escapeString(organization_id)}'`];
    
    if (start_date) {
      whereConditions.push(`timestamp >= '${start_date}'`);
    }
    
    if (end_date) {
      whereConditions.push(`timestamp <= '${end_date}'`);
    }
    
    if (event_types && event_types.length > 0) {
      const types = event_types.map(t => `'${this.escapeString(t)}'`).join(', ');
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
      FROM conversion_events
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ${limit};
    `;

    return await this.executeQuery(query);
  }

  /**
   * Get aggregated conversion metrics
   */
  async getConversionMetrics(params: {
    organization_id: string;
    start_date?: string;
    end_date?: string;
    group_by?: 'hour' | 'day' | 'week' | 'month';
  }): Promise<any[]> {
    const { organization_id, start_date, end_date, group_by = 'day' } = params;

    const dateFormat = {
      hour: "DATE_TRUNC('hour', timestamp)",
      day: "DATE_TRUNC('day', timestamp)",
      week: "DATE_TRUNC('week', timestamp)",
      month: "DATE_TRUNC('month', timestamp)"
    }[group_by];

    let whereConditions = [`organization_id = '${this.escapeString(organization_id)}'`];
    
    if (start_date) {
      whereConditions.push(`timestamp >= '${start_date}'`);
    }
    
    if (end_date) {
      whereConditions.push(`timestamp <= '${end_date}'`);
    }

    const query = `
      SELECT 
        ${dateFormat} as period,
        event_type,
        COUNT(*) as event_count,
        SUM(event_value) as total_value,
        AVG(event_value) as avg_value,
        COUNT(DISTINCT user_id) as unique_users
      FROM conversion_events
      WHERE ${whereConditions.join(' AND ')}
      GROUP BY period, event_type
      ORDER BY period DESC;
    `;

    return await this.executeQuery(query);
  }

  /**
   * Escape string to prevent SQL injection
   */
  private escapeString(str: string): string {
    return str.replace(/'/g, "''");
  }
}