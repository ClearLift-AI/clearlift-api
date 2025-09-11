import { Container, getContainer } from 'cloudflare:workers';

// Standard table schemas for the platform
export const STANDARD_SCHEMAS = {
  conversion_events: {
    id: 'VARCHAR',
    organization_id: 'VARCHAR NOT NULL',
    event_id: 'VARCHAR',
    timestamp: 'TIMESTAMP',
    event_type: 'VARCHAR',
    event_value: 'DOUBLE',
    currency: 'VARCHAR',
    user_id: 'VARCHAR',
    session_id: 'VARCHAR',
    utm_source: 'VARCHAR',
    utm_medium: 'VARCHAR',
    utm_campaign: 'VARCHAR',
    device_type: 'VARCHAR',
    browser: 'VARCHAR',
    country: 'VARCHAR',
    attribution_path: 'VARCHAR',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
  },
  campaign_metrics: {
    id: 'VARCHAR',
    organization_id: 'VARCHAR NOT NULL',
    date: 'DATE',
    platform: 'VARCHAR',
    campaign_id: 'VARCHAR',
    campaign_name: 'VARCHAR',
    impressions: 'BIGINT',
    clicks: 'BIGINT',
    spend: 'DOUBLE',
    conversions: 'BIGINT',
    revenue: 'DOUBLE',
    ctr: 'DOUBLE',
    cpc: 'DOUBLE',
    cpa: 'DOUBLE',
    roas: 'DOUBLE',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
  },
  user_interactions: {
    id: 'VARCHAR',
    organization_id: 'VARCHAR NOT NULL',
    user_id: 'VARCHAR',
    session_id: 'VARCHAR',
    timestamp: 'TIMESTAMP',
    interaction_type: 'VARCHAR',
    page_url: 'VARCHAR',
    referrer: 'VARCHAR',
    duration_seconds: 'INTEGER',
    metadata: 'VARCHAR',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
  },
  attribution_data: {
    id: 'VARCHAR',
    organization_id: 'VARCHAR NOT NULL',
    conversion_id: 'VARCHAR',
    timestamp: 'TIMESTAMP',
    attribution_model: 'VARCHAR',
    touchpoint_sequence: 'VARCHAR',
    first_touch_channel: 'VARCHAR',
    last_touch_channel: 'VARCHAR',
    attribution_weights: 'VARCHAR',
    conversion_value: 'DOUBLE',
    created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
  }
};

export interface TableInfo {
  catalog: string;
  schema: string;
  name: string;
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export class DatalakeManagementService {
  private containerBinding: any;
  private organizationId: string;

  constructor(containerBinding: any, organizationId: string) {
    this.containerBinding = containerBinding;
    this.organizationId = organizationId;
  }

  /**
   * Get a DuckLake container instance
   */
  private getContainerInstance() {
    return getContainer(this.containerBinding, this.organizationId);
  }

  /**
   * Create a new table in the datalake
   */
  async createTable(
    tableName: string, 
    schema: Record<string, string>, 
    namespace: string = 'default'
  ): Promise<{ success: boolean; message: string; table?: string }> {
    const container = this.getContainerInstance();
    
    const response = await container.fetch(new Request('http://ducklake/tables/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.organizationId}`
      },
      body: JSON.stringify({
        table_name: tableName,
        schema,
        namespace
      })
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create table: ${error}`);
    }

    return await response.json();
  }

  /**
   * List all tables in the catalog
   */
  async listTables(): Promise<TableInfo[]> {
    const container = this.getContainerInstance();
    
    const response = await container.fetch(new Request('http://ducklake/tables/list', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.organizationId}`
      }
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list tables: ${error}`);
    }

    const result = await response.json();
    return result.tables || [];
  }

  /**
   * Get schema information for a specific table
   */
  async getTableSchema(
    tableName: string, 
    namespace: string = 'default'
  ): Promise<ColumnInfo[]> {
    const container = this.getContainerInstance();
    
    const response = await container.fetch(
      new Request(`http://ducklake/tables/${namespace}/${tableName}/schema`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.organizationId}`
        }
      })
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get table schema: ${error}`);
    }

    const result = await response.json();
    return result.schema || [];
  }

  /**
   * Drop a table (with safeguards)
   */
  async dropTable(
    tableName: string, 
    namespace: string = 'default',
    confirmDrop: boolean = false
  ): Promise<{ success: boolean; message: string }> {
    if (!confirmDrop) {
      throw new Error('Table drop requires explicit confirmation');
    }

    const container = this.getContainerInstance();
    
    const query = `DROP TABLE IF EXISTS r2_catalog.${namespace}.${tableName}`;
    
    const response = await container.fetch(new Request('http://ducklake/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.organizationId}`
      },
      body: JSON.stringify({ query })
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to drop table: ${error}`);
    }

    return {
      success: true,
      message: `Table ${namespace}.${tableName} dropped successfully`
    };
  }

  /**
   * Write data to a table
   */
  async writeData(
    tableName: string,
    data: Record<string, any>[],
    namespace: string = 'default'
  ): Promise<{ success: boolean; rowsInserted: number }> {
    if (!data || data.length === 0) {
      return { success: true, rowsInserted: 0 };
    }

    const container = this.getContainerInstance();
    
    // Build INSERT query
    const columns = Object.keys(data[0]);
    const values = data.map(row => {
      const rowValues = columns.map(col => {
        const value = row[col];
        if (value === null || value === undefined) {
          return 'NULL';
        }
        if (typeof value === 'string') {
          return `'${value.replace(/'/g, "''")}'`;
        }
        if (value instanceof Date) {
          return `'${value.toISOString()}'`;
        }
        return value;
      });
      return `(${rowValues.join(', ')})`;
    });

    const query = `
      INSERT INTO r2_catalog.${namespace}.${tableName} (${columns.join(', ')})
      VALUES ${values.join(',\n')}
    `;

    const response = await container.fetch(new Request('http://ducklake/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.organizationId}`
      },
      body: JSON.stringify({ query })
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to write data: ${error}`);
    }

    return {
      success: true,
      rowsInserted: data.length
    };
  }

  /**
   * Initialize standard tables for the platform
   */
  async initializeStandardTables(): Promise<{
    created: string[];
    existing: string[];
    failed: Array<{ table: string; error: string }>;
  }> {
    const results = {
      created: [] as string[],
      existing: [] as string[],
      failed: [] as Array<{ table: string; error: string }>
    };

    // Get existing tables
    const existingTables = await this.listTables();
    const existingTableNames = existingTables.map(t => t.name);

    // Create each standard table
    for (const [tableName, schema] of Object.entries(STANDARD_SCHEMAS)) {
      if (existingTableNames.includes(tableName)) {
        results.existing.push(tableName);
        continue;
      }

      try {
        await this.createTable(tableName, schema);
        results.created.push(tableName);
      } catch (error) {
        results.failed.push({
          table: tableName,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return results;
  }

  /**
   * Execute a custom query
   */
  async executeQuery(query: string): Promise<any> {
    const container = this.getContainerInstance();
    
    const response = await container.fetch(new Request('http://ducklake/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.organizationId}`
      },
      body: JSON.stringify({ query })
    }));

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Query execution failed: ${error}`);
    }

    const result = await response.json();
    return result.data;
  }

  /**
   * Batch write data with chunking
   */
  async batchWrite(
    tableName: string,
    data: Record<string, any>[],
    batchSize: number = 1000,
    namespace: string = 'default'
  ): Promise<{ success: boolean; totalRowsInserted: number; batches: number }> {
    let totalRowsInserted = 0;
    let batches = 0;

    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      const result = await this.writeData(tableName, batch, namespace);
      totalRowsInserted += result.rowsInserted;
      batches++;
    }

    return {
      success: true,
      totalRowsInserted,
      batches
    };
  }
}