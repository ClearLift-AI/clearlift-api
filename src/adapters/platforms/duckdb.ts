/**
 * DuckDB Adapter for querying analytics from query.clearlift.ai
 */

// New API Request/Response Types
export interface DuckDBQueryRequest {
  session_token: string;
  lookback?: string;
  timeRange?: {
    start: string;
    end: string;
  };
  select?: string[];
  filters?: Record<string, any>;
  aggregate?: {
    groupBy?: string[];
    metrics?: string[];
    timeGranularity?: "minute" | "hour" | "day" | "week" | "month";
  };
  orderBy?: Array<{
    field: string;
    direction: "ASC" | "DESC";
  }>;
  limit?: number;
  offset?: number;
}

export interface DuckDBQueryResponse {
  success: boolean;
  columns?: string[];
  rows?: any[];
  rowCount?: number;
  executionTime?: number;
  metadata?: {
    tag?: string;
    partitioningUsed?: string;
    optimized?: boolean;
  };
  context?: {
    user_id?: string;
    authorized_tags?: string[];
  };
  error?: string;
}

export interface ConversionEvent {
  timestamp: string;
  eventType: string;
  sessionId: string;
  userId?: string;
  eventData?: any;
  pageData?: {
    url?: string;
    title?: string;
    path?: string;
    hostname?: string;
  };
  deviceInfo?: {
    browser?: string;
    device?: string;
    os?: string;
  };
  utmParams?: {
    source?: string;
    medium?: string;
    campaign?: string;
    term?: string;
    content?: string;
  };
}

export interface ConversionSummary {
  total_events: number;
  unique_users: number;
  unique_sessions: number;
  events_by_type: Record<string, number>;
  top_sources: Array<{ source: string; count: number }>;
  conversion_rate?: number;
}

export class DuckDBAdapter {
  private readonly baseUrl: string = "https://query.clearlift.ai";

  /**
   * Execute a query against the DuckDB API
   */
  private async query(
    orgTag: string,
    request: DuckDBQueryRequest
  ): Promise<DuckDBQueryResponse> {
    const url = `${this.baseUrl}/events/${orgTag}`;

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
          error: data?.error || `HTTP ${response.status}`
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
    const filters: any = {};
    if (options?.event_type) {
      filters.eventType = options.event_type;
    }

    const request: DuckDBQueryRequest = {
      session_token: sessionToken,
      lookback: options?.lookback || "7d",
      select: [
        "timestamp",
        "eventType",
        "sessionId",
        "userId",
        "eventData",
        "pageData",
        "deviceInfo",
        "utmParams"
      ],
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      orderBy: [{ field: "timestamp", direction: "DESC" }],
      limit: options?.limit || 100
    };

    const response = await this.query(orgTag, request);

    if (!response.success || !response.rows) {
      return {
        events: [],
        summary: {
          total_events: 0,
          unique_users: 0,
          unique_sessions: 0,
          events_by_type: {},
          top_sources: []
        }
      };
    }

    // Transform rows to ConversionEvent format
    const events: ConversionEvent[] = response.rows.map((row) => ({
      timestamp: row.timestamp,
      eventType: row.eventType,
      sessionId: row.sessionId,
      userId: row.userId,
      eventData: row.eventData,
      pageData: row.pageData,
      deviceInfo: row.deviceInfo,
      utmParams: row.utmParams
    }));

    // Calculate summary
    const summary = this.calculateSummary(events);

    return { events, summary };
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
      lookback,
      aggregate: {
        groupBy: ["eventType"],
        metrics: ["count", "distinct_users", "distinct_sessions"],
        timeGranularity: "day"
      }
    };

    const response = await this.query(orgTag, request);

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

    return this.processStats(response.rows);
  }

  /**
   * Execute a custom analytics query
   */
  async customQuery(
    sessionToken: string,
    orgTag: string,
    queryOptions: {
      lookback?: string;
      timeRange?: { start: string; end: string };
      filters?: Record<string, any>;
      aggregate?: any;
      select?: string[];
      limit?: number;
    }
  ): Promise<DuckDBQueryResponse> {
    const request: DuckDBQueryRequest = {
      session_token: sessionToken,
      ...queryOptions
    };

    return this.query(orgTag, request);
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
    // Query for each funnel step
    const stepPromises = steps.map(async (step) => {
      const request: DuckDBQueryRequest = {
        session_token: sessionToken,
        lookback,
        filters: { eventType: step },
        aggregate: {
          metrics: ["count", "distinct_users"]
        }
      };

      const response = await this.query(orgTag, request);
      return {
        step,
        data: response.rows?.[0] || { count: 0, distinct_users: 0 }
      };
    });

    const funnelData = await Promise.all(stepPromises);

    // Calculate conversion rates
    const conversionRates: number[] = [];
    for (let i = 1; i < funnelData.length; i++) {
      const prevUsers = funnelData[i - 1].data.distinct_users || 0;
      const currUsers = funnelData[i].data.distinct_users || 0;
      const rate = prevUsers > 0 ? (currUsers / prevUsers) * 100 : 0;
      conversionRates.push(rate);
    }

    return {
      steps: funnelData.map(f => ({
        step: f.step,
        users: f.data.distinct_users || 0,
        events: f.data.count || 0
      })),
      conversion_rates: conversionRates,
      overall_conversion: funnelData.length > 1 && funnelData[0].data.distinct_users > 0
        ? (funnelData[funnelData.length - 1].data.distinct_users / funnelData[0].data.distinct_users) * 100
        : 0
    };
  }

  /**
   * Calculate summary statistics from events
   */
  private calculateSummary(events: ConversionEvent[]): ConversionSummary {
    const uniqueUsers = new Set<string>();
    const uniqueSessions = new Set<string>();
    const eventsByType: Record<string, number> = {};
    const sourceCount: Record<string, number> = {};

    events.forEach((event) => {
      // Count unique users
      if (event.userId) {
        uniqueUsers.add(event.userId);
      }

      // Count unique sessions
      if (event.sessionId) {
        uniqueSessions.add(event.sessionId);
      }

      // Count events by type
      eventsByType[event.eventType] = (eventsByType[event.eventType] || 0) + 1;

      // Count sources
      if (event.utmParams?.source) {
        sourceCount[event.utmParams.source] = (sourceCount[event.utmParams.source] || 0) + 1;
      }
    });

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
   * Process aggregated statistics data
   */
  private processStats(rows: any[]): any {
    let totalEvents = 0;
    let totalUniqueUsers = 0;
    const eventTypes: Record<string, number> = {};
    const dailyData: any[] = [];

    rows.forEach((row) => {
      if (row.count) totalEvents += row.count;
      if (row.distinct_users) totalUniqueUsers = Math.max(totalUniqueUsers, row.distinct_users);

      if (row.eventType) {
        eventTypes[row.eventType] = row.count || 0;
      }

      // If we have time-based data
      if (row.time_bucket) {
        dailyData.push({
          date: row.time_bucket,
          events: row.count || 0,
          users: row.distinct_users || 0,
          sessions: row.distinct_sessions || 0
        });
      }
    });

    return {
      daily_events: dailyData,
      event_types: eventTypes,
      total_events: totalEvents,
      unique_users: totalUniqueUsers
    };
  }
}