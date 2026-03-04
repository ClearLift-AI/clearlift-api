/**
 * Analytics Engine Service
 *
 * Provides real-time analytics queries via Cloudflare Analytics Engine SQL API.
 * Data is written to Analytics Engine from clearlift-events worker.
 *
 * Schema mapping (Architecture D — adbliss_events dataset):
 *
 * Index:
 *   index1 = org_tag
 *
 * Blobs:
 *   blob1  = event_type
 *   blob2  = utm_source
 *   blob3  = utm_medium
 *   blob4  = utm_campaign
 *   blob5  = device_type
 *   blob6  = geo_country
 *   blob7  = browser_name
 *   blob8  = os_name
 *   blob9  = page_path
 *   blob10 = page_hostname
 *   blob11 = referrer_domain
 *   blob12 = geo_region
 *   blob13 = geo_city
 *   blob14 = session_id
 *   blob15 = anonymous_id
 *   blob16 = navigation_type
 *   blob17 = click_destination_hostname
 *   blob18 = utm_term
 *   blob19 = utm_content
 *   blob20 = sdk_version
 *
 * Doubles:
 *   double1  = event count (always 1)
 *   double2  = goal_value * 100 (conversion value cents)
 *   double3  = is_new_session ? 1 : 0
 *   double4  = page_view flag
 *   double5  = click flag
 *   double6  = form_submit flag
 *   double7  = conversion flag
 *   double8  = engagement_time
 *   double9  = scroll_depth
 *   double10 = gclid flag
 *   double11 = fbclid flag
 *   double12 = ttclid flag
 *   double13 = msclkid flag
 *   double14 = nav click flag
 *   double15 = VPN flag
 *   double16 = referred session flag
 *   double17 = custom event flag
 *   double18-20 = reserved
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

import { sanitizeString, validatePositiveInt } from '../utils/sanitize';
import { structuredLog } from '../utils/structured-logger';

export class AnalyticsEngineService {
  private readonly apiUrl: string;

  constructor(
    private accountId: string,
    private apiToken: string,
    private dataset: string = 'adbliss_events'
  ) {
    this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  }

  private sanitizeString(value: string): string {
    return sanitizeString(value);
  }

  private validatePositiveInt(value: number, name: string): number {
    return validatePositiveInt(value, name);
  }

  /** Known-safe Analytics Engine column names for dimension queries */
  private static readonly ALLOWED_COLUMNS = new Set([
    'index1',
    'blob1', 'blob2', 'blob3', 'blob4', 'blob5', 'blob6', 'blob7', 'blob8',
    'blob9', 'blob10', 'blob11', 'blob12', 'blob13', 'blob14', 'blob15',
    'blob16', 'blob17', 'blob18', 'blob19', 'blob20',
    'double1', 'double2', 'double3', 'double4', 'double5', 'double6', 'double7',
    'double8', 'double9', 'double10', 'double11', 'double12', 'double13',
    'double14', 'double15', 'double16', 'double17', 'double18', 'double19', 'double20',
  ]);

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
      structuredLog('ERROR', 'Query failed', { service: 'AnalyticsEngine', error: error });
      throw new Error(`Analytics Engine query failed: ${error}`);
    }

    const result = await response.json() as { data: T[] };
    console.log(`[AnalyticsEngine] Query returned ${result.data?.length || 0} rows`);
    return result.data || [];
  }

  /**
   * Get real-time summary for an organization.
   * All counts are multiplied by _sample_interval for accurate totals.
   */
  async getSummary(orgTag: string, hours: number = 24): Promise<AnalyticsEngineSummary> {
    const safeOrgTag = this.sanitizeString(orgTag);
    const safeHours = this.validatePositiveInt(hours, 'hours');

    const sql = `
      SELECT
        SUM(_sample_interval * double1) as total_events,
        SUM(_sample_interval * double3) as new_sessions,
        COUNT(DISTINCT blob15) as unique_users,
        SUM(_sample_interval * double7) as conversions,
        SUM(_sample_interval * double2) as revenue_cents,
        SUM(_sample_interval * double4) as page_views
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${safeHours}' HOUR
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
   * Get time series data for charts.
   * All counts are multiplied by _sample_interval for accurate totals.
   */
  async getTimeSeries(
    orgTag: string,
    hours: number = 24,
    interval: 'hour' | '15min' = 'hour'
  ): Promise<AnalyticsEngineTimeSeries[]> {
    const safeOrgTag = this.sanitizeString(orgTag);
    const safeHours = this.validatePositiveInt(hours, 'hours');

    const bucket = interval === 'hour'
      ? "toStartOfHour(timestamp)"
      : "toStartOfFifteenMinutes(timestamp)";

    const sql = `
      SELECT
        ${bucket} as bucket,
        SUM(_sample_interval * double1) as events,
        SUM(_sample_interval * double3) as sessions,
        SUM(_sample_interval * double4) as page_views,
        SUM(_sample_interval * double7) as conversions
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${safeHours}' HOUR
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
   * Get breakdown by dimension.
   * All counts are multiplied by _sample_interval for accurate totals.
   */
  async getBreakdown(
    orgTag: string,
    dimension: 'utm_source' | 'utm_medium' | 'utm_campaign' | 'device' | 'country' | 'page' | 'browser' | 'os' | 'referrer' | 'region' | 'city',
    hours: number = 24
  ): Promise<AnalyticsEngineBreakdown[]> {
    const safeOrgTag = this.sanitizeString(orgTag);
    const safeHours = this.validatePositiveInt(hours, 'hours');

    // Map dimension to Analytics Engine blob column
    const dimMap: Record<string, string> = {
      utm_source:   'blob2',
      utm_medium:   'blob3',
      utm_campaign: 'blob4',
      device:       'blob5',
      country:      'blob6',
      browser:      'blob7',
      os:           'blob8',
      page:         'blob9',
      referrer:     'blob11',
      region:       'blob12',
      city:         'blob13',
    };

    const col = dimMap[dimension];
    if (!col) {
      throw new Error(`Unknown dimension: ${dimension}`);
    }

    // Validate column name against allowlist even though it comes from dimMap,
    // as defense-in-depth against future code changes
    if (!AnalyticsEngineService.ALLOWED_COLUMNS.has(col)) {
      throw new Error(`Invalid column name: ${col}`);
    }

    const sql = `
      SELECT
        ${col} as dimension,
        SUM(_sample_interval * double1) as events,
        SUM(_sample_interval * double3) as sessions,
        SUM(_sample_interval * double7) as conversions,
        SUM(_sample_interval * double2) as revenue_cents
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${safeHours}' HOUR
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
   * Get event types breakdown.
   * Uses blob1 for event_type. All counts multiplied by _sample_interval.
   */
  async getEventTypes(orgTag: string, hours: number = 24): Promise<AnalyticsEngineBreakdown[]> {
    const safeOrgTag = this.sanitizeString(orgTag);
    const safeHours = this.validatePositiveInt(hours, 'hours');

    const sql = `
      SELECT
        blob1 as dimension,
        SUM(_sample_interval * double1) as events,
        SUM(_sample_interval * double3) as sessions,
        SUM(_sample_interval * double7) as conversions,
        SUM(_sample_interval * double2) as revenue_cents
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${safeHours}' HOUR
      GROUP BY blob1
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
   * Get real-time events (last N minutes).
   * Uses blob columns for event_type, page_path, device_type, country, utm_source.
   */
  async getRecentEvents(orgTag: string, minutes: number = 5, limit: number = 100): Promise<any[]> {
    const safeOrgTag = this.sanitizeString(orgTag);
    const safeMinutes = this.validatePositiveInt(minutes, 'minutes');
    const safeLimit = this.validatePositiveInt(limit, 'limit');

    const sql = `
      SELECT
        timestamp,
        blob1 as event_type,
        blob9 as page_path,
        blob5 as device_type,
        blob6 as country,
        blob2 as utm_source,
        double7 as is_conversion,
        double2 as goal_value
      FROM ${this.dataset}
      WHERE index1 = '${safeOrgTag}'
        AND timestamp > NOW() - INTERVAL '${safeMinutes}' MINUTE
      ORDER BY timestamp DESC
      LIMIT ${safeLimit}
    `;

    return this.query(sql);
  }
}
