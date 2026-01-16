/**
 * Analytics Engine Service
 *
 * Provides real-time analytics queries via Cloudflare Analytics Engine SQL API.
 * Data is written to Analytics Engine from clearlift-events worker.
 *
 * Schema mapping:
 * - index1: org_tag (partition key)
 * - index2: event_type
 * - index3: utm_source
 * - index4: utm_medium
 * - index5: utm_campaign
 * - index6: device_type
 * - index7: geo_country
 * - index8: browser_name
 * - blob1: page_path
 * - blob2: page_hostname
 * - blob3: session_id
 * - blob4: anonymous_id
 * - blob5: referrer_domain
 * - blob6: geo_city
 * - double1: event_count (always 1)
 * - double2: goal_value (cents)
 * - double3: new_session flag
 * - double4: page_view flag
 * - double5: click flag
 * - double6: form_submit flag
 * - double7: conversion flag
 * - double8: engagement_time
 * - double9: scroll_depth
 */

export interface AnalyticsEngineSummary {
  totalEvents: number;
  sessions: number;
  users: number;
  conversions: number;
  revenue: number;
  pageViews: number;
}

export interface AnalyticsEngineTimeSeries {
  bucket: string;
  events: number;
  sessions: number;
  pageViews: number;
  conversions: number;
}

export interface AnalyticsEngineBreakdown {
  dimension: string;
  events: number;
  sessions: number;
  conversions: number;
  revenue: number;
}

export class AnalyticsEngineService {
  private readonly apiUrl: string;

  constructor(
    private accountId: string,
    private apiToken: string,
    private dataset: string = 'clearlift_events'
  ) {
    this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  }

  /**
   * Query Analytics Engine via SQL API
   */
  async query<T = any>(sql: string): Promise<T[]> {
    console.log('[AnalyticsEngine] Executing query:', sql.substring(0, 200) + '...');

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[AnalyticsEngine] Query failed:', error);
      throw new Error(`Analytics Engine query failed: ${error}`);
    }

    const result = await response.json() as { data: T[] };
    console.log(`[AnalyticsEngine] Query returned ${result.data?.length || 0} rows`);
    return result.data || [];
  }

  /**
   * Get real-time summary for an organization
   */
  async getSummary(orgTag: string, hours: number = 24): Promise<AnalyticsEngineSummary> {
    // Escape single quotes in orgTag to prevent SQL injection
    const safeOrgTag = orgTag.replace(/'/g, "''");

    const sql = `
      SELECT
        SUM(double1) as total_events,
        SUM(double3) as new_sessions,
        COUNT(DISTINCT blob4) as unique_users,
        SUM(double7) as conversions,
        SUM(double2) as revenue_cents,
        SUM(double4) as page_views
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${hours}' HOUR
    `;

    const rows = await this.query<{
      total_events: number;
      new_sessions: number;
      unique_users: number;
      conversions: number;
      revenue_cents: number;
      page_views: number;
    }>(sql);

    const row = rows[0] || {};

    return {
      totalEvents: row.total_events || 0,
      sessions: row.new_sessions || 0,
      users: row.unique_users || 0,
      conversions: row.conversions || 0,
      revenue: (row.revenue_cents || 0) / 100,
      pageViews: row.page_views || 0,
    };
  }

  /**
   * Get time series data for charts
   */
  async getTimeSeries(
    orgTag: string,
    hours: number = 24,
    interval: 'hour' | '15min' = 'hour'
  ): Promise<AnalyticsEngineTimeSeries[]> {
    const safeOrgTag = orgTag.replace(/'/g, "''");

    const bucket = interval === 'hour'
      ? "toStartOfHour(timestamp)"
      : "toStartOfFifteenMinutes(timestamp)";

    const sql = `
      SELECT
        ${bucket} as bucket,
        SUM(double1) as events,
        SUM(double3) as sessions,
        SUM(double4) as page_views,
        SUM(double7) as conversions
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${hours}' HOUR
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const rows = await this.query<{
      bucket: string;
      events: number;
      sessions: number;
      page_views: number;
      conversions: number;
    }>(sql);

    return rows.map(row => ({
      bucket: row.bucket,
      events: row.events || 0,
      sessions: row.sessions || 0,
      pageViews: row.page_views || 0,
      conversions: row.conversions || 0,
    }));
  }

  /**
   * Get breakdown by dimension
   */
  async getBreakdown(
    orgTag: string,
    dimension: 'utm_source' | 'utm_medium' | 'utm_campaign' | 'device' | 'country' | 'page' | 'browser',
    hours: number = 24
  ): Promise<AnalyticsEngineBreakdown[]> {
    const safeOrgTag = orgTag.replace(/'/g, "''");

    // Map dimension to Analytics Engine column
    const dimMap: Record<string, string> = {
      utm_source: 'index3',
      utm_medium: 'index4',
      utm_campaign: 'index5',
      device: 'index6',
      country: 'index7',
      browser: 'index8',
      page: 'blob1',
    };

    const col = dimMap[dimension];
    if (!col) {
      throw new Error(`Unknown dimension: ${dimension}`);
    }

    const sql = `
      SELECT
        ${col} as dimension,
        SUM(double1) as events,
        SUM(double3) as sessions,
        SUM(double7) as conversions,
        SUM(double2) as revenue_cents
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${hours}' HOUR
        AND ${col} != ''
      GROUP BY ${col}
      ORDER BY events DESC
      LIMIT 50
    `;

    const rows = await this.query<{
      dimension: string;
      events: number;
      sessions: number;
      conversions: number;
      revenue_cents: number;
    }>(sql);

    return rows.map(row => ({
      dimension: row.dimension || '(not set)',
      events: row.events || 0,
      sessions: row.sessions || 0,
      conversions: row.conversions || 0,
      revenue: (row.revenue_cents || 0) / 100,
    }));
  }

  /**
   * Get event types breakdown
   */
  async getEventTypes(orgTag: string, hours: number = 24): Promise<AnalyticsEngineBreakdown[]> {
    const safeOrgTag = orgTag.replace(/'/g, "''");

    const sql = `
      SELECT
        index2 as dimension,
        SUM(double1) as events,
        SUM(double3) as sessions,
        SUM(double7) as conversions,
        SUM(double2) as revenue_cents
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${hours}' HOUR
      GROUP BY index2
      ORDER BY events DESC
      LIMIT 20
    `;

    const rows = await this.query<{
      dimension: string;
      events: number;
      sessions: number;
      conversions: number;
      revenue_cents: number;
    }>(sql);

    return rows.map(row => ({
      dimension: row.dimension || 'unknown',
      events: row.events || 0,
      sessions: row.sessions || 0,
      conversions: row.conversions || 0,
      revenue: (row.revenue_cents || 0) / 100,
    }));
  }

  /**
   * Get real-time events (last N minutes)
   */
  async getRecentEvents(orgTag: string, minutes: number = 5, limit: number = 100): Promise<any[]> {
    const safeOrgTag = orgTag.replace(/'/g, "''");

    const sql = `
      SELECT
        timestamp,
        index2 as event_type,
        blob1 as page_path,
        index6 as device_type,
        index7 as country,
        index3 as utm_source,
        double7 as is_conversion,
        double2 as goal_value
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${minutes}' MINUTE
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    return this.query(sql);
  }
}
