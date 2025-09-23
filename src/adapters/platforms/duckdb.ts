/**
 * DuckDB Adapter for querying analytics from query.clearlift.ai
 */

export interface DuckDBQueryRequest {
  session_token: string;
  tag: string;
  query_type: "events" | "stats" | "raw";
  lookback?: string; // e.g., "24h", "7d", "30d"
  limit?: number;
  custom_query?: string; // For raw SQL queries
}

export interface DuckDBQueryResponse {
  success: boolean;
  columns?: string[];
  rows?: any[];
  rowCount?: number;
  executionTime?: number;
  context?: {
    user_id: string;
    tag: string;
    session_id: string;
  };
  error?: string;
  debug?: any;
}

export interface ConversionEvent {
  timestamp: string;
  event_id: string;
  event_type: string;
  event_value?: number;
  user_id?: string;
  session_id?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  device_type?: string;
  browser?: string;
  country?: string;
  attribution_path?: any;
}

export interface ConversionSummary {
  total_events: number;
  unique_users: number;
  total_value: number;
  events_by_type: Record<string, number>;
  top_sources: Array<{ source: string; count: number }>;
  conversion_rate?: number;
}

export class DuckDBAdapter {
  private readonly baseUrl: string = "https://query.clearlift.ai";

  /**
   * Execute a query against the DuckDB API
   */
  private async query(request: DuckDBQueryRequest): Promise<DuckDBQueryResponse> {
    const url = `${this.baseUrl}/api/query`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request)
      });

      const data = await response.json() as DuckDBQueryResponse;

      if (!response.ok) {
        return {
          success: false,
          error: data?.error || `HTTP ${response.status}`,
          debug: (data as any)?.debug
        };
      }

      return data;
    } catch (error) {
      console.error("DuckDB query error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Query failed"
      };
    }
  }

  /**
   * Get conversion events for an organization
   */
  async getConversions(
    sessionToken: string,
    orgTag: string,
    options?: {
      lookback?: string;
      event_type?: string;
      limit?: number;
    }
  ): Promise<{
    events: ConversionEvent[];
    summary: ConversionSummary;
  }> {
    const request: DuckDBQueryRequest = {
      session_token: sessionToken,
      tag: orgTag,
      query_type: "events",
      lookback: options?.lookback || "7d",
      limit: options?.limit || 100
    };

    const response = await this.query(request);

    if (!response.success || !response.rows) {
      return {
        events: [],
        summary: {
          total_events: 0,
          unique_users: 0,
          total_value: 0,
          events_by_type: {},
          top_sources: []
        }
      };
    }

    // Transform rows to ConversionEvent format
    const events: ConversionEvent[] = response.rows.map((row) => ({
      timestamp: row.timestamp || row.created_at,
      event_id: row.eventId || row.event_id,
      event_type: row.eventType || row.event_type,
      event_value: row.eventValue || row.event_value,
      user_id: row.userId || row.user_id,
      session_id: row.sessionId || row.session_id,
      utm_source: row.utm_source,
      utm_medium: row.utm_medium,
      utm_campaign: row.utm_campaign,
      device_type: row.device_type || row.deviceType,
      browser: row.browser,
      country: row.country,
      attribution_path: row.attribution_path
    }));

    // Filter by event type if specified
    const filteredEvents = options?.event_type
      ? events.filter((e) => e.event_type === options.event_type)
      : events;

    // Calculate summary
    const summary = this.calculateSummary(filteredEvents);

    return { events: filteredEvents, summary };
  }

  /**
   * Get aggregated statistics
   */
  async getStats(
    sessionToken: string,
    orgTag: string,
    lookback: string = "7d"
  ): Promise<any> {
    const request: DuckDBQueryRequest = {
      session_token: sessionToken,
      tag: orgTag,
      query_type: "stats",
      lookback
    };

    const response = await this.query(request);

    if (!response.success || !response.rows) {
      return {
        daily_events: [],
        event_types: {},
        sources: {},
        devices: {},
        total_events: 0,
        unique_users: 0
      };
    }

    // Process stats data
    return this.processStats(response.rows);
  }

  /**
   * Execute a custom SQL query
   */
  async customQuery(
    sessionToken: string,
    orgTag: string,
    sql: string
  ): Promise<DuckDBQueryResponse> {
    const request: DuckDBQueryRequest = {
      session_token: sessionToken,
      tag: orgTag,
      query_type: "raw",
      custom_query: sql
    };

    return this.query(request);
  }

  /**
   * Get conversion funnel data
   */
  async getFunnel(
    sessionToken: string,
    orgTag: string,
    steps: string[],
    lookback: string = "7d"
  ): Promise<any> {
    // Build funnel query
    const sql = `
      WITH funnel_steps AS (
        SELECT
          user_id,
          event_type,
          MIN(timestamp) as first_occurrence
        FROM events
        WHERE tag = '${orgTag}'
          AND event_type IN (${steps.map((s) => `'${s}'`).join(",")})
          AND timestamp > NOW() - INTERVAL '${lookback}'
        GROUP BY user_id, event_type
      )
      SELECT
        event_type as step,
        COUNT(DISTINCT user_id) as users,
        COUNT(*) as events
      FROM funnel_steps
      GROUP BY event_type
      ORDER BY ARRAY_POSITION(ARRAY[${steps.map((s) => `'${s}'`).join(",")}], event_type)
    `;

    const response = await this.customQuery(sessionToken, orgTag, sql);

    if (!response.success || !response.rows) {
      return { steps: [], conversion_rates: [] };
    }

    // Calculate conversion rates
    const funnel = response.rows;
    const conversionRates: number[] = [];

    for (let i = 1; i < funnel.length; i++) {
      const rate = funnel[i - 1].users > 0
        ? (funnel[i].users / funnel[i - 1].users) * 100
        : 0;
      conversionRates.push(rate);
    }

    return {
      steps: funnel,
      conversion_rates: conversionRates,
      overall_conversion: funnel.length > 1 && funnel[0].users > 0
        ? (funnel[funnel.length - 1].users / funnel[0].users) * 100
        : 0
    };
  }

  /**
   * Calculate summary statistics from events
   */
  private calculateSummary(events: ConversionEvent[]): ConversionSummary {
    const uniqueUsers = new Set<string>();
    const eventsByType: Record<string, number> = {};
    const sourceCount: Record<string, number> = {};
    let totalValue = 0;

    events.forEach((event) => {
      // Count unique users
      if (event.user_id) {
        uniqueUsers.add(event.user_id);
      }

      // Count events by type
      eventsByType[event.event_type] = (eventsByType[event.event_type] || 0) + 1;

      // Count sources
      if (event.utm_source) {
        sourceCount[event.utm_source] = (sourceCount[event.utm_source] || 0) + 1;
      }

      // Sum values
      totalValue += event.event_value || 0;
    });

    // Get top sources
    const topSources = Object.entries(sourceCount)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      total_events: events.length,
      unique_users: uniqueUsers.size,
      total_value: totalValue,
      events_by_type: eventsByType,
      top_sources: topSources
    };
  }

  /**
   * Process statistics data from DuckDB
   */
  private processStats(rows: any[]): any {
    const daily: Record<string, any> = {};
    const eventTypes: Record<string, number> = {};
    const sources: Record<string, number> = {};
    const devices: Record<string, number> = {};
    const uniqueUsers = new Set<string>();

    rows.forEach((row) => {
      // Group by date
      const date = row.date || row.timestamp?.split("T")[0];
      if (date) {
        if (!daily[date]) {
          daily[date] = { events: 0, users: new Set(), value: 0 };
        }
        daily[date].events += row.count || 1;
        if (row.user_id) daily[date].users.add(row.user_id);
        daily[date].value += row.value || 0;
      }

      // Count by type
      if (row.event_type) {
        eventTypes[row.event_type] = (eventTypes[row.event_type] || 0) + (row.count || 1);
      }

      // Count by source
      if (row.utm_source) {
        sources[row.utm_source] = (sources[row.utm_source] || 0) + (row.count || 1);
      }

      // Count by device
      if (row.device_type) {
        devices[row.device_type] = (devices[row.device_type] || 0) + (row.count || 1);
      }

      // Track unique users
      if (row.user_id) {
        uniqueUsers.add(row.user_id);
      }
    });

    // Convert daily data
    const dailyEvents = Object.entries(daily).map(([date, data]: [string, any]) => ({
      date,
      events: data.events,
      users: data.users.size,
      value: data.value
    }));

    return {
      daily_events: dailyEvents,
      event_types: eventTypes,
      sources,
      devices,
      total_events: dailyEvents.reduce((sum, day) => sum + day.events, 0),
      unique_users: uniqueUsers.size
    };
  }
}