/**
 * Supabase Client Service
 *
 * Handles all interactions with Supabase database for connector data
 */

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export class SupabaseClient {
  private headers: HeadersInit;

  constructor(private config: SupabaseConfig) {
    this.headers = {
      'Content-Type': 'application/json',
      'apikey': config.serviceKey,
      'Authorization': `Bearer ${config.serviceKey}`,
      'Prefer': 'return=representation',
      'Accept-Profile': 'clearlift',
      'Content-Profile': 'clearlift'
    };
  }

  /**
   * Generic query method for Supabase REST API
   */
  private async query<T = any>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.config.url}/rest/v1/${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase query failed: ${response.status} - ${error}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return await response.json();
    }

    return await response.text() as T;
  }

  /**
   * Insert records into a table
   */
  async insert<T = any>(
    table: string,
    records: any | any[],
    options: { onConflict?: string; returning?: boolean } = {}
  ): Promise<T> {
    const headers: HeadersInit = { ...this.headers };

    if (options.onConflict) {
      headers['Prefer'] = `resolution=merge-duplicates,return=${options.returning ? 'representation' : 'minimal'}`;
    } else if (options.returning) {
      headers['Prefer'] = 'return=representation';
    }

    return await this.query<T>(table, {
      method: 'POST',
      headers,
      body: JSON.stringify(records)
    });
  }

  /**
   * Update records in a table
   */
  async update<T = any>(
    table: string,
    updates: any,
    filter: string
  ): Promise<T> {
    return await this.query<T>(`${table}?${filter}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
  }

  /**
   * Delete records from a table
   */
  async delete(
    table: string,
    filter: string
  ): Promise<void> {
    await this.query(`${table}?${filter}`, {
      method: 'DELETE',
      headers: {
        ...this.headers,
        'Prefer': 'return=minimal'
      }
    });
  }

  /**
   * Select records from a table
   */
  async select<T = any>(
    table: string,
    query: string = '',
    options: {
      select?: string;
      order?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<T[]> {
    const params = new URLSearchParams();

    if (query) {
      params.append('or', query);
    }

    if (options.select) {
      params.append('select', options.select);
    }

    if (options.order) {
      params.append('order', options.order);
    }

    if (options.limit) {
      params.append('limit', String(options.limit));
    }

    if (options.offset) {
      params.append('offset', String(options.offset));
    }

    const endpoint = params.toString() ? `${table}?${params}` : table;
    return await this.query<T[]>(endpoint, { method: 'GET' });
  }

  /**
   * Execute an RPC function
   */
  async rpc<T = any>(
    functionName: string,
    params: any = {}
  ): Promise<T> {
    return await this.query<T>(`rpc/${functionName}`, {
      method: 'POST',
      body: JSON.stringify(params)
    });
  }

  /**
   * Upsert records (insert or update)
   */
  async upsert<T = any>(
    table: string,
    records: any | any[],
    options: {
      onConflict: string;
      returning?: boolean;
    }
  ): Promise<T> {
    const headers: HeadersInit = {
      ...this.headers,
      'Prefer': `resolution=merge-duplicates,return=${options.returning ? 'representation' : 'minimal'}`
    };

    return await this.query<T>(table, {
      method: 'POST',
      headers,
      body: JSON.stringify(records)
    });
  }

  /**
   * Query with JSONB filters
   */
  async queryJsonb<T = any>(
    table: string,
    filters: Array<{
      column: string;
      operator: 'contains' | 'contained' | 'has_key' | 'has_any_keys' | 'has_all_keys';
      value: any;
    }>,
    options: {
      select?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<T[]> {
    const params = new URLSearchParams();

    // Build JSONB filter query
    const filterStrings: string[] = [];
    for (const filter of filters) {
      switch (filter.operator) {
        case 'contains':
          filterStrings.push(`${filter.column}.cs.${JSON.stringify(filter.value)}`);
          break;
        case 'contained':
          filterStrings.push(`${filter.column}.cd.${JSON.stringify(filter.value)}`);
          break;
        case 'has_key':
          filterStrings.push(`${filter.column}.has.${filter.value}`);
          break;
        case 'has_any_keys':
          filterStrings.push(`${filter.column}.ov.{${filter.value.join(',')}}`);
          break;
        case 'has_all_keys':
          filterStrings.push(`${filter.column}.contains.${JSON.stringify(filter.value)}`);
          break;
      }
    }

    if (filterStrings.length > 0) {
      params.append('and', `(${filterStrings.join(',')})`);
    }

    if (options.select) {
      params.append('select', options.select);
    }

    if (options.limit) {
      params.append('limit', String(options.limit));
    }

    if (options.offset) {
      params.append('offset', String(options.offset));
    }

    const endpoint = `${table}?${params}`;
    return await this.query<T[]>(endpoint, { method: 'GET' });
  }

  /**
   * Batch insert for better performance
   */
  async batchInsert<T = any>(
    table: string,
    records: any[],
    batchSize: number = 1000
  ): Promise<void> {
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      await this.insert(table, batch, { returning: false });
    }
  }
}