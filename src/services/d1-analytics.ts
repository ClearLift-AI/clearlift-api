/**
 * D1 Analytics Service
 *
 * Service for reading analytics data from D1 ANALYTICS_DB.
 * Used in the dev environment where we use D1 instead of Supabase.
 */

// D1Database type comes from worker-configuration.d.ts
declare const D1Database: unique symbol;
type D1Database = {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta?: {
    changed_db: boolean;
    changes: number;
    last_row_id: number;
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

interface D1ExecResult {
  count: number;
  duration: number;
}

/**
 * Hourly metrics row from D1
 */
export interface HourlyMetricRow {
  org_tag: string;
  hour: string;
  total_events: number;
  page_views: number;
  clicks: number;
  form_submits: number;
  custom_events: number;
  sessions: number;
  users: number;
  devices: number;
  conversions: number;
  revenue_cents: number;
  by_channel: string;
  by_device: string;
}

/**
 * Daily metrics row from D1
 */
export interface DailyMetricRow {
  org_tag: string;
  date: string;
  total_events: number;
  page_views: number;
  clicks: number;
  form_submits: number;
  custom_events: number;
  sessions: number;
  users: number;
  devices: number;
  new_users: number;
  returning_users: number;
  conversions: number;
  revenue_cents: number;
  conversion_rate: number;
  by_channel: string;
  by_device: string;
  by_geo: string;
  by_page: string;
  by_utm_source: string;
  by_utm_campaign: string;
}

/**
 * UTM performance row from D1
 */
export interface UTMPerformanceRow {
  org_tag: string;
  date: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  sessions: number;
  users: number;
  page_views: number;
  conversions: number;
  revenue_cents: number;
  conversion_rate: number;
}

/**
 * Journey row from D1
 */
export interface JourneyRow {
  id: string;
  org_tag: string;
  anonymous_id: string;
  channel_path: string;
  path_length: number;
  first_touch_ts: string;
  last_touch_ts: string;
  converted: number;
  conversion_value_cents: number;
}

/**
 * Attribution result row from D1
 */
export interface AttributionResultRow {
  org_tag: string;
  model: string;
  channel: string;
  credit: number;
  conversions: number;
  revenue_cents: number;
  removal_effect: number | null;
  shapley_value: number | null;
  period_start: string;
  period_end: string;
}

/**
 * D1 Analytics Service
 */
export class D1AnalyticsService {
  constructor(private db: D1Database) {}

  /**
   * Get hourly metrics for an org
   */
  async getHourlyMetrics(orgTag: string, startDate: string, endDate: string): Promise<HourlyMetricRow[]> {
    const result = await this.db.prepare(`
      SELECT *
      FROM hourly_metrics
      WHERE org_tag = ?
        AND hour >= ?
        AND hour <= ?
      ORDER BY hour DESC
    `).bind(orgTag, startDate, endDate).all<HourlyMetricRow>();

    return result.results;
  }

  /**
   * Get daily metrics for an org
   */
  async getDailyMetrics(orgTag: string, startDate: string, endDate: string): Promise<DailyMetricRow[]> {
    const result = await this.db.prepare(`
      SELECT *
      FROM daily_metrics
      WHERE org_tag = ?
        AND date >= ?
        AND date <= ?
      ORDER BY date DESC
    `).bind(orgTag, startDate, endDate).all<DailyMetricRow>();

    return result.results;
  }

  /**
   * Get UTM performance for an org
   */
  async getUTMPerformance(orgTag: string, startDate: string, endDate: string): Promise<UTMPerformanceRow[]> {
    const result = await this.db.prepare(`
      SELECT *
      FROM utm_performance
      WHERE org_tag = ?
        AND date >= ?
        AND date <= ?
      ORDER BY date DESC, sessions DESC
    `).bind(orgTag, startDate, endDate).all<UTMPerformanceRow>();

    return result.results;
  }

  /**
   * Get journeys for an org
   */
  async getJourneys(orgTag: string, limit: number = 100, convertedOnly: boolean = false): Promise<JourneyRow[]> {
    let query = `
      SELECT *
      FROM journeys
      WHERE org_tag = ?
    `;

    if (convertedOnly) {
      query += ` AND converted = 1`;
    }

    query += ` ORDER BY first_touch_ts DESC LIMIT ?`;

    const result = await this.db.prepare(query)
      .bind(orgTag, limit)
      .all<JourneyRow>();

    return result.results;
  }

  /**
   * Get attribution results for an org
   */
  async getAttributionResults(
    orgTag: string,
    model?: string,
    periodStart?: string,
    periodEnd?: string
  ): Promise<AttributionResultRow[]> {
    let query = `
      SELECT *
      FROM attribution_results
      WHERE org_tag = ?
    `;
    const params: unknown[] = [orgTag];

    if (model) {
      query += ` AND model = ?`;
      params.push(model);
    }

    if (periodStart) {
      query += ` AND period_start >= ?`;
      params.push(periodStart);
    }

    if (periodEnd) {
      query += ` AND period_end <= ?`;
      params.push(periodEnd);
    }

    query += ` ORDER BY computed_at DESC, credit DESC`;

    const stmt = this.db.prepare(query);
    const result = await stmt.bind(...params).all<AttributionResultRow>();

    return result.results;
  }

  /**
   * Get analytics summary for dashboard overview
   */
  async getAnalyticsSummary(orgTag: string, days: number = 7): Promise<{
    totalEvents: number;
    totalSessions: number;
    totalUsers: number;
    totalConversions: number;
    totalRevenue: number;
    conversionRate: number;
    topChannels: { channel: string; sessions: number; conversions: number }[];
    topCampaigns: { campaign: string; sessions: number; revenue: number }[];
  }> {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Get daily metrics summary
    const dailyMetrics = await this.getDailyMetrics(orgTag, startDate, endDate);

    // Aggregate totals
    let totalEvents = 0;
    let totalSessions = 0;
    let totalUsers = 0;
    let totalConversions = 0;
    let totalRevenue = 0;
    const channelAgg: Record<string, { sessions: number; conversions: number }> = {};

    for (const dm of dailyMetrics) {
      totalEvents += dm.total_events;
      totalSessions += dm.sessions;
      totalUsers += dm.users;
      totalConversions += dm.conversions;
      totalRevenue += dm.revenue_cents;

      // Parse channel breakdown
      try {
        const byChannel = JSON.parse(dm.by_channel || '{}') as Record<string, number>;
        for (const [channel, count] of Object.entries(byChannel)) {
          if (!channelAgg[channel]) {
            channelAgg[channel] = { sessions: 0, conversions: 0 };
          }
          channelAgg[channel].sessions += count;
        }
      } catch {}
    }

    // Get UTM campaign summary
    const utmPerf = await this.getUTMPerformance(orgTag, startDate, endDate);
    const campaignAgg: Record<string, { sessions: number; revenue: number }> = {};
    for (const utm of utmPerf) {
      const campaign = utm.utm_campaign || 'none';
      if (!campaignAgg[campaign]) {
        campaignAgg[campaign] = { sessions: 0, revenue: 0 };
      }
      campaignAgg[campaign].sessions += utm.sessions;
      campaignAgg[campaign].revenue += utm.revenue_cents;
    }

    // Sort and take top 5
    const topChannels = Object.entries(channelAgg)
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .slice(0, 5)
      .map(([channel, stats]) => ({ channel, ...stats }));

    const topCampaigns = Object.entries(campaignAgg)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 5)
      .map(([campaign, stats]) => ({ campaign, ...stats }));

    return {
      totalEvents,
      totalSessions,
      totalUsers,
      totalConversions,
      totalRevenue: totalRevenue / 100, // Convert cents to dollars
      conversionRate: totalSessions > 0 ? totalConversions / totalSessions : 0,
      topChannels,
      topCampaigns
    };
  }

  /**
   * Get channel transitions for Markov visualization
   */
  async getChannelTransitions(orgTag: string, periodStart?: string): Promise<{
    from_channel: string;
    to_channel: string;
    probability: number;
    transition_count: number;
  }[]> {
    let query = `
      SELECT from_channel, to_channel, probability, transition_count
      FROM channel_transitions
      WHERE org_tag = ?
    `;
    const params: unknown[] = [orgTag];

    if (periodStart) {
      query += ` AND period_start = ?`;
      params.push(periodStart);
    }

    query += ` ORDER BY transition_count DESC`;

    const stmt = this.db.prepare(query);
    const result = await stmt.bind(...params).all<{
      from_channel: string;
      to_channel: string;
      probability: number;
      transition_count: number;
    }>();

    return result.results;
  }
}
