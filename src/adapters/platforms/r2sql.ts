/**
 * R2 SQL Adapter for querying event data from Cloudflare R2 Data Catalog
 *
 * This adapter provides a direct interface to R2 SQL REST API for querying
 * Iceberg tables stored in R2. Due to R2 SQL limitations (no GROUP BY, no
 * aggregation functions), this adapter fetches raw data and performs
 * aggregations client-side.
 */

// Event schema - matches the 60-field schema in R2
export interface EventRecord {
  // Core fields
  org_tag: string;
  timestamp: string;
  sessionId: string;
  userId?: string;
  eventType: string;

  // Event data
  eventData?: Record<string, any>;

  // Page context
  pageData?: {
    url?: string;
    title?: string;
    path?: string;
    hostname?: string;
    referrer?: string;
  };

  // Device/browser info
  deviceInfo?: {
    browser?: string;
    device?: string;
    os?: string;
    viewport?: string;
  };

  // UTM parameters
  utmParams?: {
    source?: string;
    medium?: string;
    campaign?: string;
    term?: string;
    content?: string;
  };

  // Additional fields (expand as needed for all 60 fields)
  [key: string]: any;
}

// R2 SQL Request
export interface R2SQLQueryRequest {
  query: string;
}

// R2 SQL Response
export interface R2SQLQueryResponse {
  result?: {
    rows: any[];
    schema?: {
      name: string;
      type: string;
    }[];
    meta?: {
      rows_read?: number;
      rows_written?: number;
      bytes_read?: number;
    };
  };
  success?: boolean;
  errors?: Array<{
    message: string;
    code?: number;
  }>;
  messages?: string[];
}

// Query options
export interface QueryOptions {
  lookback?: string;
  timeRange?: {
    start: string;
    end: string;
  };
  filters?: Record<string, any>;
  limit?: number;
  offset?: number;
  select?: string[];
}

// Summary statistics
export interface EventSummary {
  total_events: number;
  unique_users: number;
  unique_sessions: number;
  events_by_type: Record<string, number>;
  top_sources: Array<{ source: string; count: number }>;
}

export class R2SQLAdapter {
  private readonly baseUrl: string;
  private readonly accountId: string;
  private readonly bucketName: string;
  private readonly token: string;

  constructor(accountId: string, bucketName: string, token: string) {
    this.accountId = accountId;
    this.bucketName = bucketName;
    this.token = token;
    this.baseUrl = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${accountId}/r2-sql/query/${bucketName}`;
  }

  /**
   * Execute a SQL query against R2
   */
  private async executeQuery(sql: string): Promise<R2SQLQueryResponse> {
    try {
      console.log(`Executing R2 SQL query: ${sql.substring(0, 200)}...`);

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query: sql })
      });

      const data = await response.json() as R2SQLQueryResponse;

      if (!response.ok) {
        console.error("R2 SQL query failed:", data);
        return {
          success: false,
          errors: data.errors || [{ message: `HTTP ${response.status}` }]
        };
      }

      if (data.errors && data.errors.length > 0) {
        console.error("R2 SQL query errors:", data.errors);
        return {
          success: false,
          errors: data.errors
        };
      }

      console.log(`R2 SQL returned ${data.result?.rows?.length || 0} rows`);

      return {
        success: true,
        result: data.result
      };
    } catch (error) {
      console.error("R2 SQL query exception:", error);
      return {
        success: false,
        errors: [{ message: error instanceof Error ? error.message : "Query failed" }]
      };
    }
  }

  /**
   * Validate SQL query to prevent injection and ensure SELECT-only
   */
  private validateQuery(sql: string): { valid: boolean; error?: string } {
    const trimmed = sql.trim().toUpperCase();

    // Must start with SELECT
    if (!trimmed.startsWith("SELECT")) {
      return { valid: false, error: "Only SELECT queries are allowed" };
    }

    // Block dangerous keywords
    const blocked = ["DROP", "DELETE", "INSERT", "UPDATE", "CREATE", "ALTER", "TRUNCATE", "EXEC"];
    for (const keyword of blocked) {
      if (trimmed.includes(keyword)) {
        return { valid: false, error: `Keyword '${keyword}' is not allowed` };
      }
    }

    return { valid: true };
  }

  /**
   * Build WHERE clause for time filtering
   */
  private buildTimeFilter(options: QueryOptions): string {
    if (options.timeRange) {
      return `timestamp >= '${options.timeRange.start}' AND timestamp <= '${options.timeRange.end}'`;
    }

    if (options.lookback) {
      // Parse lookback (e.g., "24h", "7d")
      const match = options.lookback.match(/^(\d+)([hdwm])$/);
      if (!match) return "";

      const [, amount, unit] = match;
      const intervals: Record<string, string> = {
        h: "HOUR",
        d: "DAY",
        w: "WEEK",
        m: "MONTH"
      };

      return `timestamp >= CURRENT_TIMESTAMP - INTERVAL '${amount}' ${intervals[unit]}`;
    }

    return "";
  }

  /**
   * Build WHERE clause for additional filters
   */
  private buildFilters(filters: Record<string, any>): string[] {
    const clauses: string[] = [];

    for (const [key, value] of Object.entries(filters)) {
      if (value === null || value === undefined) continue;

      if (Array.isArray(value)) {
        // IN clause for arrays
        const values = value.map(v => `'${this.escapeValue(v)}'`).join(", ");
        clauses.push(`${key} IN (${values})`);
      } else if (typeof value === "string") {
        clauses.push(`${key} = '${this.escapeValue(value)}'`);
      } else {
        clauses.push(`${key} = ${value}`);
      }
    }

    return clauses;
  }

  /**
   * Escape SQL values to prevent injection
   */
  private escapeValue(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Build SQL query from options
   */
  private buildQuery(orgTag: string, options: QueryOptions): string {
    const select = options.select?.join(", ") || "*";
    const limit = options.limit || 1000;
    const offset = options.offset || 0;

    // Start with SELECT
    let sql = `SELECT ${select} FROM clearlift.events`;

    // Build WHERE clauses
    const whereClauses: string[] = [];

    // Always filter by org_tag
    whereClauses.push(`org_tag = '${this.escapeValue(orgTag)}'`);

    // Add time filter
    const timeFilter = this.buildTimeFilter(options);
    if (timeFilter) {
      whereClauses.push(timeFilter);
    }

    // Add custom filters
    if (options.filters) {
      whereClauses.push(...this.buildFilters(options.filters));
    }

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    // Note: R2 SQL doesn't support ORDER BY except on partition keys
    // We'll sort client-side if needed

    // Add LIMIT and OFFSET
    sql += ` LIMIT ${limit}`;
    if (offset > 0) {
      sql += ` OFFSET ${offset}`;
    }

    return sql;
  }

  /**
   * Get raw events with filters
   */
  async getEvents(
    orgTag: string,
    options: QueryOptions = {}
  ): Promise<{
    events: EventRecord[];
    rowCount: number;
    error?: string;
  }> {
    const sql = this.buildQuery(orgTag, options);
    const validation = this.validateQuery(sql);

    if (!validation.valid) {
      return {
        events: [],
        rowCount: 0,
        error: validation.error
      };
    }

    const response = await this.executeQuery(sql);

    if (!response.success || !response.result) {
      const errorMsg = response.errors?.[0]?.message || "Query failed";
      return {
        events: [],
        rowCount: 0,
        error: errorMsg
      };
    }

    const events = response.result.rows as EventRecord[];

    // Sort by timestamp DESC if not already sorted
    events.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return {
      events,
      rowCount: events.length
    };
  }

  /**
   * Calculate summary statistics from events
   */
  calculateSummary(events: EventRecord[]): EventSummary {
    const uniqueUsers = new Set<string>();
    const uniqueSessions = new Set<string>();
    const eventsByType: Record<string, number> = {};
    const sourceCount: Record<string, number> = {};

    for (const event of events) {
      // Count unique users
      if (event.userId) {
        uniqueUsers.add(event.userId);
      }

      // Count unique sessions
      if (event.sessionId) {
        uniqueSessions.add(event.sessionId);
      }

      // Count events by type
      if (event.eventType) {
        eventsByType[event.eventType] = (eventsByType[event.eventType] || 0) + 1;
      }

      // Count sources
      const source = event.utmParams?.source;
      if (source) {
        sourceCount[source] = (sourceCount[source] || 0) + 1;
      }
    }

    // Get top sources
    const topSources = Object.entries(sourceCount)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      total_events: events.length,
      unique_users: uniqueUsers.size,
      unique_sessions: uniqueSessions.size,
      events_by_type: eventsByType,
      top_sources: topSources
    };
  }

  /**
   * Get events with summary statistics
   */
  async getEventsWithSummary(
    orgTag: string,
    options: QueryOptions = {}
  ): Promise<{
    events: EventRecord[];
    summary: EventSummary;
    error?: string;
  }> {
    const result = await this.getEvents(orgTag, options);

    if (result.error) {
      return {
        events: [],
        summary: {
          total_events: 0,
          unique_users: 0,
          unique_sessions: 0,
          events_by_type: {},
          top_sources: []
        },
        error: result.error
      };
    }

    const summary = this.calculateSummary(result.events);

    return {
      events: result.events,
      summary
    };
  }

  /**
   * Get aggregated statistics
   * Since R2 SQL doesn't support GROUP BY, we fetch raw data and aggregate client-side
   */
  async getStats(
    orgTag: string,
    lookback: string = "7d"
  ): Promise<{
    event_types: Record<string, number>;
    total_events: number;
    unique_users: number;
    unique_sessions: number;
    error?: string;
  }> {
    // Fetch raw events with minimal fields for performance
    const result = await this.getEvents(orgTag, {
      lookback,
      select: ["eventType", "userId", "sessionId", "timestamp"],
      limit: 10000 // Fetch more for better stats
    });

    if (result.error) {
      return {
        event_types: {},
        total_events: 0,
        unique_users: 0,
        unique_sessions: 0,
        error: result.error
      };
    }

    const summary = this.calculateSummary(result.events);

    return {
      event_types: summary.events_by_type,
      total_events: summary.total_events,
      unique_users: summary.unique_users,
      unique_sessions: summary.unique_sessions
    };
  }

  /**
   * Get conversion funnel
   * Calculates step-by-step conversion rates for a sequence of events
   */
  async getFunnel(
    orgTag: string,
    steps: string[],
    lookback: string = "7d"
  ): Promise<{
    steps: Array<{
      step: string;
      users: number;
      events: number;
    }>;
    conversion_rates: number[];
    overall_conversion: number;
    error?: string;
  }> {
    // Fetch all events for the funnel steps
    const result = await this.getEvents(orgTag, {
      lookback,
      filters: {
        eventType: steps
      },
      select: ["eventType", "userId", "sessionId", "timestamp"],
      limit: 10000
    });

    if (result.error) {
      return {
        steps: [],
        conversion_rates: [],
        overall_conversion: 0,
        error: result.error
      };
    }

    // Calculate metrics for each step
    const stepData = steps.map(step => {
      const stepEvents = result.events.filter(e => e.eventType === step);
      const uniqueUsers = new Set(stepEvents.map(e => e.userId).filter(Boolean));

      return {
        step,
        users: uniqueUsers.size,
        events: stepEvents.length
      };
    });

    // Calculate conversion rates
    const conversionRates: number[] = [];
    for (let i = 1; i < stepData.length; i++) {
      const prevUsers = stepData[i - 1].users;
      const currUsers = stepData[i].users;
      const rate = prevUsers > 0 ? (currUsers / prevUsers) * 100 : 0;
      conversionRates.push(rate);
    }

    const overallConversion = stepData.length > 1 && stepData[0].users > 0
      ? (stepData[stepData.length - 1].users / stepData[0].users) * 100
      : 0;

    return {
      steps: stepData,
      conversion_rates: conversionRates,
      overall_conversion: overallConversion
    };
  }
}