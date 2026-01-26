/**
 * D1 Analytics Service
 *
 * Service for reading analytics data from D1 ANALYTICS_DB.
 * Supports D1 Read Replication via Sessions API for global low-latency reads.
 */

// D1 types come from worker-configuration.d.ts (global Cloudflare types)
// D1Database, D1DatabaseSession, D1PreparedStatement, D1Result are globally available

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

// =============================================================================
// PLATFORM DATA INTERFACES
// =============================================================================

export interface GoogleCampaignRow {
  id: string;
  organization_id: string;
  customer_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  campaign_type: string | null;
  budget_amount_cents: number | null;
  budget_type: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoogleCampaignMetricsRow {
  campaign_ref: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  conversions: number;
  conversion_value_cents: number;
  ctr: number;
  cpc_cents: number;
  cpm_cents: number;
}

export interface FacebookCampaignRow {
  id: string;
  organization_id: string;
  account_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  objective: string | null;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FacebookCampaignMetricsRow {
  campaign_ref: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  reach: number;
  frequency: number;
  conversions: number;
  ctr: number;
  cpc_cents: number;
  cpm_cents: number;
}

export interface TikTokCampaignRow {
  id: string;
  organization_id: string;
  advertiser_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  objective: string | null;
  budget_mode: string | null;
  budget_cents: number | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TikTokCampaignMetricsRow {
  campaign_ref: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  reach: number;
  conversions: number;
  video_views: number;
  ctr: number;
  cpc_cents: number;
  cpm_cents: number;
}

export interface CampaignWithMetrics {
  campaign_id: string;
  campaign_name: string;
  status: string;
  last_synced_at: string | null;
  metrics: {
    impressions: number;
    clicks: number;
    spend: number;
    conversions: number;
    revenue: number;
    ctr: number;
    cpc: number;
  };
}

export interface PlatformSummary {
  spend_cents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value_cents: number;
  campaigns: number;
}

/**
 * D1 Analytics Service
 *
 * Uses Sessions API for read replication support.
 * All queries within a request share the same session for sequential consistency.
 */
export class D1AnalyticsService {
  private session: D1DatabaseSession;

  constructor(db: D1Database) {
    // Create a session for consistent reads across replicas
    // 'first-unconstrained' allows the first query to hit any replica
    // (better for read-heavy analytics vs 'first-primary')
    this.session = db.withSession('first-unconstrained');
  }

  /**
   * Get hourly metrics for an org
   */
  async getHourlyMetrics(orgTag: string, startDate: string, endDate: string): Promise<HourlyMetricRow[]> {
    const result = await this.session.prepare(`
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
    const result = await this.session.prepare(`
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
    const result = await this.session.prepare(`
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

    const result = await this.session.prepare(query)
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

    const stmt = this.session.prepare(query);
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
   * Returns Markov transition matrix with probabilities
   */
  async getChannelTransitions(
    orgTag: string,
    options: {
      periodStart?: string;
      periodEnd?: string;
      fromChannel?: string;
      toChannel?: string;
      minCount?: number;
    } = {}
  ): Promise<{
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

    if (options.periodStart) {
      query += ` AND period_start >= ?`;
      params.push(options.periodStart);
    }

    if (options.periodEnd) {
      query += ` AND period_end <= ?`;
      params.push(options.periodEnd);
    }

    if (options.fromChannel) {
      query += ` AND from_channel = ?`;
      params.push(options.fromChannel);
    }

    if (options.toChannel) {
      query += ` AND to_channel = ?`;
      params.push(options.toChannel);
    }

    if (options.minCount !== undefined && options.minCount > 0) {
      query += ` AND transition_count >= ?`;
      params.push(options.minCount);
    }

    query += ` ORDER BY transition_count DESC`;

    const stmt = this.session.prepare(query);
    const result = await stmt.bind(...params).all<{
      from_channel: string;
      to_channel: string;
      probability: number;
      transition_count: number;
    }>();

    return result.results;
  }

  // =============================================================================
  // GOOGLE ADS PLATFORM DATA
  // =============================================================================

  /**
   * Get Google Ads campaigns for an organization
   */
  async getGoogleCampaigns(
    orgId: string,
    options: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<GoogleCampaignRow[]> {
    let query = `
      SELECT * FROM google_campaigns
      WHERE organization_id = ?
    `;
    const params: unknown[] = [orgId];

    if (options.status) {
      query += ` AND campaign_status = ?`;
      params.push(options.status);
    }

    query += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(options.limit || 100, options.offset || 0);

    const result = await this.session.prepare(query).bind(...params).all<GoogleCampaignRow>();
    return result.results;
  }

  /**
   * Get Google Ads campaign metrics for a date range
   */
  async getGoogleCampaignMetrics(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<GoogleCampaignMetricsRow[]> {
    // Query unified ad_metrics table for Google campaign metrics
    const result = await this.session.prepare(`
      SELECT
        m.id,
        m.organization_id,
        m.entity_ref as campaign_ref,
        m.metric_date,
        m.impressions,
        m.clicks,
        m.spend_cents,
        m.conversions,
        m.conversion_value_cents,
        CASE WHEN m.impressions > 0 THEN CAST(m.clicks AS REAL) / m.impressions ELSE 0 END as ctr,
        CASE WHEN m.clicks > 0 THEN m.spend_cents / m.clicks ELSE 0 END as cpc_cents,
        CASE WHEN m.impressions > 0 THEN (m.spend_cents * 1000.0) / m.impressions ELSE 0 END as cpm_cents
      FROM ad_metrics m
      WHERE m.organization_id = ?
        AND m.platform = 'google'
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      ORDER BY m.metric_date DESC
    `).bind(orgId, startDate, endDate).all<GoogleCampaignMetricsRow>();

    return result.results;
  }

  /**
   * Get Google Ads campaigns with aggregated metrics
   */
  async getGoogleCampaignsWithMetrics(
    orgId: string,
    startDate: string,
    endDate: string,
    options: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<CampaignWithMetrics[]> {
    // Query unified tables
    let query = `
      SELECT
        c.id,
        c.campaign_id,
        c.campaign_name,
        c.campaign_status as status,
        c.updated_at as last_synced_at,
        COALESCE(SUM(m.impressions), 0) as impressions,
        COALESCE(SUM(m.clicks), 0) as clicks,
        COALESCE(SUM(m.spend_cents), 0) as spend_cents,
        COALESCE(SUM(m.conversions), 0) as conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as conversion_value_cents
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.organization_id = ? AND c.platform = 'google'
    `;
    const params: unknown[] = [startDate, endDate, orgId];

    if (options.status) {
      // Map frontend status to unified status
      const statusMap: Record<string, string> = { 'ENABLED': 'active', 'PAUSED': 'paused', 'REMOVED': 'deleted' };
      query += ` AND c.campaign_status = ?`;
      params.push(statusMap[options.status] || options.status.toLowerCase());
    }

    query += ` GROUP BY c.id ORDER BY spend_cents DESC LIMIT ? OFFSET ?`;
    params.push(options.limit || 100, options.offset || 0);

    const result = await this.session.prepare(query).bind(...params).all<any>();

    return result.results.map((row: any) => ({
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      status: row.status,
      last_synced_at: row.last_synced_at,
      metrics: {
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
        spend: (row.spend_cents || 0) / 100,
        conversions: row.conversions || 0,
        revenue: (row.conversion_value_cents || 0) / 100,
        ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
        cpc: row.clicks > 0 ? (row.spend_cents / row.clicks) / 100 : 0,
      },
    }));
  }

  /**
   * Get Google Ads summary for an organization
   */
  async getGoogleSummary(orgId: string, startDate: string, endDate: string): Promise<PlatformSummary> {
    // Query unified tables
    const result = await this.session.prepare(`
      SELECT
        COALESCE(SUM(m.spend_cents), 0) as spend_cents,
        COALESCE(SUM(m.impressions), 0) as impressions,
        COALESCE(SUM(m.clicks), 0) as clicks,
        COALESCE(SUM(m.conversions), 0) as conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as conversion_value_cents,
        COUNT(DISTINCT c.id) as campaigns
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.organization_id = ? AND c.platform = 'google'
    `).bind(startDate, endDate, orgId).first<PlatformSummary>();

    return result || { spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value_cents: 0, campaigns: 0 };
  }

  // =============================================================================
  // FACEBOOK ADS PLATFORM DATA
  // =============================================================================

  /**
   * Get Facebook Ads campaigns for an organization
   */
  async getFacebookCampaigns(
    orgId: string,
    options: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<FacebookCampaignRow[]> {
    // Query unified tables (returning legacy-compatible format)
    let query = `
      SELECT
        id, organization_id, account_id, campaign_id, campaign_name,
        campaign_status, objective, daily_budget_cents, lifetime_budget_cents,
        updated_at as last_synced_at, created_at, updated_at
      FROM ad_campaigns
      WHERE organization_id = ? AND platform = 'facebook'
    `;
    const params: unknown[] = [orgId];

    if (options.status) {
      const statusMap: Record<string, string> = { 'ACTIVE': 'active', 'PAUSED': 'paused', 'DELETED': 'deleted', 'ARCHIVED': 'archived' };
      query += ` AND campaign_status = ?`;
      params.push(statusMap[options.status] || options.status.toLowerCase());
    }

    query += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(options.limit || 100, options.offset || 0);

    const result = await this.session.prepare(query).bind(...params).all<FacebookCampaignRow>();
    return result.results;
  }

  /**
   * Get Facebook Ads campaigns with aggregated metrics
   */
  async getFacebookCampaignsWithMetrics(
    orgId: string,
    startDate: string,
    endDate: string,
    options: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<CampaignWithMetrics[]> {
    // Query unified tables
    let query = `
      SELECT
        c.id,
        c.campaign_id,
        c.campaign_name,
        c.campaign_status as status,
        c.updated_at as last_synced_at,
        COALESCE(SUM(m.impressions), 0) as impressions,
        COALESCE(SUM(m.clicks), 0) as clicks,
        COALESCE(SUM(m.spend_cents), 0) as spend_cents,
        COALESCE(SUM(m.conversions), 0) as conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as conversion_value_cents
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.organization_id = ? AND c.platform = 'facebook'
    `;
    const params: unknown[] = [startDate, endDate, orgId];

    if (options.status) {
      const statusMap: Record<string, string> = { 'ACTIVE': 'active', 'PAUSED': 'paused', 'DELETED': 'deleted', 'ARCHIVED': 'archived' };
      query += ` AND c.campaign_status = ?`;
      params.push(statusMap[options.status] || options.status.toLowerCase());
    }

    query += ` GROUP BY c.id ORDER BY spend_cents DESC LIMIT ? OFFSET ?`;
    params.push(options.limit || 100, options.offset || 0);

    const result = await this.session.prepare(query).bind(...params).all<any>();

    return result.results.map((row: any) => ({
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      status: row.status,
      last_synced_at: row.last_synced_at,
      metrics: {
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
        spend: (row.spend_cents || 0) / 100,
        conversions: row.conversions || 0,
        revenue: (row.conversion_value_cents || 0) / 100,
        ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
        cpc: row.clicks > 0 ? (row.spend_cents / row.clicks) / 100 : 0,
      },
    }));
  }

  /**
   * Get Facebook Ads summary for an organization
   */
  async getFacebookSummary(orgId: string, startDate: string, endDate: string): Promise<PlatformSummary> {
    // Query unified tables
    const result = await this.session.prepare(`
      SELECT
        COALESCE(SUM(m.spend_cents), 0) as spend_cents,
        COALESCE(SUM(m.impressions), 0) as impressions,
        COALESCE(SUM(m.clicks), 0) as clicks,
        COALESCE(SUM(m.conversions), 0) as conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as conversion_value_cents,
        COUNT(DISTINCT c.id) as campaigns
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.organization_id = ? AND c.platform = 'facebook'
    `).bind(startDate, endDate, orgId).first<PlatformSummary>();

    return result || { spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value_cents: 0, campaigns: 0 };
  }

  // =============================================================================
  // TIKTOK ADS PLATFORM DATA
  // =============================================================================

  /**
   * Get TikTok Ads campaigns for an organization
   */
  async getTikTokCampaigns(
    orgId: string,
    options: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<TikTokCampaignRow[]> {
    // Query unified tables (returning legacy-compatible format)
    let query = `
      SELECT
        id, organization_id, account_id as advertiser_id, campaign_id, campaign_name,
        campaign_status, objective, budget_mode, budget_cents,
        updated_at as last_synced_at, created_at, updated_at
      FROM ad_campaigns
      WHERE organization_id = ? AND platform = 'tiktok'
    `;
    const params: unknown[] = [orgId];

    if (options.status) {
      const statusMap: Record<string, string> = { 'ACTIVE': 'active', 'PAUSED': 'paused', 'DELETED': 'deleted' };
      query += ` AND campaign_status = ?`;
      params.push(statusMap[options.status] || options.status.toLowerCase());
    }

    query += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(options.limit || 100, options.offset || 0);

    const result = await this.session.prepare(query).bind(...params).all<TikTokCampaignRow>();
    return result.results;
  }

  /**
   * Get TikTok Ads campaigns with aggregated metrics
   */
  async getTikTokCampaignsWithMetrics(
    orgId: string,
    startDate: string,
    endDate: string,
    options: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<CampaignWithMetrics[]> {
    // Query unified tables
    let query = `
      SELECT
        c.id,
        c.campaign_id,
        c.campaign_name,
        c.campaign_status as status,
        c.updated_at as last_synced_at,
        COALESCE(SUM(m.impressions), 0) as impressions,
        COALESCE(SUM(m.clicks), 0) as clicks,
        COALESCE(SUM(m.spend_cents), 0) as spend_cents,
        COALESCE(SUM(m.conversions), 0) as conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as conversion_value_cents
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.organization_id = ? AND c.platform = 'tiktok'
    `;
    const params: unknown[] = [startDate, endDate, orgId];

    if (options.status) {
      const statusMap: Record<string, string> = { 'ACTIVE': 'active', 'PAUSED': 'paused', 'DELETED': 'deleted' };
      query += ` AND c.campaign_status = ?`;
      params.push(statusMap[options.status] || options.status.toLowerCase());
    }

    query += ` GROUP BY c.id ORDER BY spend_cents DESC LIMIT ? OFFSET ?`;
    params.push(options.limit || 100, options.offset || 0);

    const result = await this.session.prepare(query).bind(...params).all<any>();

    return result.results.map((row: any) => ({
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      status: row.status,
      last_synced_at: row.last_synced_at,
      metrics: {
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
        spend: (row.spend_cents || 0) / 100,
        conversions: row.conversions || 0,
        revenue: (row.conversion_value_cents || 0) / 100,
        ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
        cpc: row.clicks > 0 ? (row.spend_cents / row.clicks) / 100 : 0,
      },
    }));
  }

  /**
   * Get TikTok Ads summary for an organization
   */
  async getTikTokSummary(orgId: string, startDate: string, endDate: string): Promise<PlatformSummary> {
    // Query unified tables
    const result = await this.session.prepare(`
      SELECT
        COALESCE(SUM(m.spend_cents), 0) as spend_cents,
        COALESCE(SUM(m.impressions), 0) as impressions,
        COALESCE(SUM(m.clicks), 0) as clicks,
        COALESCE(SUM(m.conversions), 0) as conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as conversion_value_cents,
        COUNT(DISTINCT c.id) as campaigns
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.entity_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.organization_id = ? AND c.platform = 'tiktok'
    `).bind(startDate, endDate, orgId).first<PlatformSummary>();

    return result || { spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value_cents: 0, campaigns: 0 };
  }

  // =============================================================================
  // UNIFIED PLATFORM DATA
  // =============================================================================

  /**
   * Get unified platform summary across all ad platforms
   * Uses unified ad_campaigns and ad_metrics tables
   */
  async getUnifiedPlatformSummary(
    orgId: string,
    startDate: string,
    endDate: string,
    platforms: string[]
  ): Promise<{ summary: PlatformSummary; by_platform: Record<string, PlatformSummary> }> {
    // Normalize 'meta' to 'facebook' for query purposes
    const normalizedPlatforms = platforms.map(p => p === 'meta' ? 'facebook' : p);
    const uniquePlatforms = [...new Set(normalizedPlatforms)];

    // If no platforms requested, return empty
    if (uniquePlatforms.length === 0) {
      return {
        summary: { spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value_cents: 0, campaigns: 0 },
        by_platform: {}
      };
    }

    // Build platform filter
    const placeholders = uniquePlatforms.map(() => '?').join(', ');

    // Single query against unified tables
    const query = `
      SELECT
        c.platform,
        COALESCE(SUM(m.spend_cents), 0) as spend_cents,
        COALESCE(SUM(m.impressions), 0) as impressions,
        COALESCE(SUM(m.clicks), 0) as clicks,
        COALESCE(SUM(m.conversions), 0) as conversions,
        COALESCE(SUM(m.conversion_value_cents), 0) as conversion_value_cents,
        COUNT(DISTINCT c.id) as campaigns
      FROM ad_campaigns c
      LEFT JOIN ad_metrics m
        ON c.id = m.campaign_ref
        AND m.entity_type = 'campaign'
        AND m.metric_date >= ?
        AND m.metric_date <= ?
      WHERE c.organization_id = ?
        AND c.platform IN (${placeholders})
      GROUP BY c.platform
    `;
    const params: unknown[] = [startDate, endDate, orgId, ...uniquePlatforms];

    const result = await this.session.prepare(query).bind(...params).all<{
      platform: string;
      spend_cents: number;
      impressions: number;
      clicks: number;
      conversions: number;
      conversion_value_cents: number;
      campaigns: number;
    }>();

    // Process results
    const by_platform: Record<string, PlatformSummary> = {};
    let totalSummary: PlatformSummary = {
      spend_cents: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversion_value_cents: 0,
      campaigns: 0,
    };

    for (const row of result.results) {
      const summary: PlatformSummary = {
        spend_cents: row.spend_cents,
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
        conversion_value_cents: row.conversion_value_cents,
        campaigns: row.campaigns,
      };

      // Map 'facebook' back to 'meta' if that was the original request
      const platformKey = platforms.includes('meta') && row.platform === 'facebook' ? 'meta' : row.platform;
      by_platform[platformKey] = summary;

      totalSummary.spend_cents += summary.spend_cents;
      totalSummary.impressions += summary.impressions;
      totalSummary.clicks += summary.clicks;
      totalSummary.conversions += summary.conversions;
      totalSummary.conversion_value_cents += summary.conversion_value_cents;
      totalSummary.campaigns += summary.campaigns;
    }

    return { summary: totalSummary, by_platform };
  }

  // =============================================================================
  // STRIPE DATA
  // =============================================================================

  /**
   * Get Stripe charges for an organization
   */
  async getStripeCharges(
    orgId: string,
    connectionId: string,
    startDate: string,
    endDate: string,
    options: { status?: string; currency?: string; minAmount?: number; maxAmount?: number; limit?: number; offset?: number } = {}
  ): Promise<StripeChargeRow[]> {
    let query = `
      SELECT *
      FROM stripe_charges
      WHERE organization_id = ?
        AND connection_id = ?
        AND stripe_created_at >= ?
        AND stripe_created_at <= ?
    `;
    const params: unknown[] = [orgId, connectionId, startDate, endDate + 'T23:59:59Z'];

    if (options.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    }
    if (options.currency) {
      query += ` AND currency = ?`;
      params.push(options.currency);
    }
    if (options.minAmount !== undefined) {
      query += ` AND amount_cents >= ?`;
      params.push(options.minAmount * 100);
    }
    if (options.maxAmount !== undefined) {
      query += ` AND amount_cents <= ?`;
      params.push(options.maxAmount * 100);
    }

    query += ` ORDER BY stripe_created_at DESC LIMIT ? OFFSET ?`;
    params.push(options.limit || 100, options.offset || 0);

    const result = await this.session.prepare(query).bind(...params).all<StripeChargeRow>();
    return result.results;
  }

  /**
   * Get Stripe daily summary for an organization
   */
  async getStripeDailySummary(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<StripeDailySummaryRow[]> {
    const result = await this.session.prepare(`
      SELECT *
      FROM stripe_daily_summary
      WHERE organization_id = ?
        AND summary_date >= ?
        AND summary_date <= ?
      ORDER BY summary_date DESC
    `).bind(orgId, startDate, endDate).all<StripeDailySummaryRow>();

    return result.results;
  }

  /**
   * Get Stripe revenue summary for an organization (computed from charges if daily summary missing)
   */
  async getStripeSummary(
    orgId: string,
    connectionId: string,
    startDate: string,
    endDate: string
  ): Promise<StripeSummary> {
    const result = await this.session.prepare(`
      SELECT
        COUNT(*) as total_transactions,
        COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END), 0) as total_revenue_cents,
        COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) as successful_count,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM stripe_charges
      WHERE organization_id = ?
        AND connection_id = ?
        AND stripe_created_at >= ?
        AND stripe_created_at <= ?
    `).bind(orgId, connectionId, startDate, endDate + 'T23:59:59Z').first<{
      total_transactions: number;
      total_revenue_cents: number;
      successful_count: number;
      unique_customers: number;
    }>();

    return {
      total_revenue: (result?.total_revenue_cents || 0) / 100,
      total_units: result?.total_transactions || 0,
      transaction_count: result?.successful_count || 0,
      unique_customers: result?.unique_customers || 0,
      average_order_value: result?.successful_count
        ? ((result?.total_revenue_cents || 0) / result.successful_count) / 100
        : 0,
    };
  }

  /**
   * Get Stripe charges with time series aggregation
   */
  async getStripeTimeSeries(
    orgId: string,
    connectionId: string,
    startDate: string,
    endDate: string,
    groupBy: 'day' | 'week' | 'month' = 'day'
  ): Promise<StripeTimeSeriesRow[]> {
    let dateFormat: string;
    switch (groupBy) {
      case 'week':
        dateFormat = "strftime('%Y-W%W', stripe_created_at)";
        break;
      case 'month':
        dateFormat = "strftime('%Y-%m', stripe_created_at)";
        break;
      default:
        dateFormat = "date(stripe_created_at)";
    }

    const result = await this.session.prepare(`
      SELECT
        ${dateFormat} as date,
        SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END) as revenue_cents,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as transactions,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM stripe_charges
      WHERE organization_id = ?
        AND connection_id = ?
        AND stripe_created_at >= ?
        AND stripe_created_at <= ?
      GROUP BY ${dateFormat}
      ORDER BY date ASC
    `).bind(orgId, connectionId, startDate, endDate + 'T23:59:59Z').all<{
      date: string;
      revenue_cents: number;
      transactions: number;
      unique_customers: number;
    }>();

    return result.results.map(row => ({
      date: row.date,
      revenue: row.revenue_cents / 100,
      transactions: row.transactions,
      unique_customers: row.unique_customers,
    }));
  }

  /**
   * Get real-time Stripe summary for the last N hours
   * Used by Real-Time analytics when business_type is 'ecommerce' or 'saas'
   */
  async getStripeRealtimeSummary(
    orgId: string,
    hours: number = 24
  ): Promise<StripeRealtimeSummary> {
    const result = await this.session.prepare(`
      SELECT
        COUNT(*) as total_charges,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as successful_charges,
        SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END) as total_revenue_cents,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM stripe_charges
      WHERE organization_id = ?
        AND stripe_created_at >= datetime('now', '-' || ? || ' hours')
    `).bind(orgId, hours).first<{
      total_charges: number;
      successful_charges: number;
      total_revenue_cents: number;
      unique_customers: number;
    }>();

    return {
      conversions: result?.successful_charges || 0,
      revenue: (result?.total_revenue_cents || 0) / 100,
      totalCharges: result?.total_charges || 0,
      uniqueCustomers: result?.unique_customers || 0,
    };
  }

  /**
   * Get real-time Stripe time series for charts
   */
  async getStripeRealtimeTimeSeries(
    orgId: string,
    hours: number = 24
  ): Promise<StripeRealtimeTimeSeriesRow[]> {
    const result = await this.session.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', stripe_created_at) as bucket,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END) as revenue_cents
      FROM stripe_charges
      WHERE organization_id = ?
        AND stripe_created_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY strftime('%Y-%m-%d %H:00:00', stripe_created_at)
      ORDER BY bucket ASC
    `).bind(orgId, hours).all<{
      bucket: string;
      conversions: number;
      revenue_cents: number;
    }>();

    return result.results.map(row => ({
      bucket: row.bucket,
      conversions: row.conversions,
      revenue: row.revenue_cents / 100,
    }));
  }

  /**
   * Get real-time Shopify summary for the last N hours
   * Used by Real-Time analytics when business_type is 'ecommerce'
   */
  async getShopifyRealtimeSummary(
    orgId: string,
    hours: number = 24
  ): Promise<ShopifyRealtimeSummary> {
    const result = await this.session.prepare(`
      SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) as paid_orders,
        SUM(CASE WHEN financial_status = 'paid' THEN total_price_cents ELSE 0 END) as total_revenue_cents,
        COUNT(DISTINCT customer_id) as unique_customers
      FROM shopify_orders
      WHERE organization_id = ?
        AND shopify_created_at >= datetime('now', '-' || ? || ' hours')
    `).bind(orgId, hours).first<{
      total_orders: number;
      paid_orders: number;
      total_revenue_cents: number;
      unique_customers: number;
    }>();

    return {
      conversions: result?.paid_orders || 0,
      revenue: (result?.total_revenue_cents || 0) / 100,
      totalOrders: result?.total_orders || 0,
      uniqueCustomers: result?.unique_customers || 0,
    };
  }

  /**
   * Get real-time Shopify time series for charts
   */
  async getShopifyRealtimeTimeSeries(
    orgId: string,
    hours: number = 24
  ): Promise<ShopifyRealtimeTimeSeriesRow[]> {
    const result = await this.session.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', shopify_created_at) as bucket,
        SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN financial_status = 'paid' THEN total_price_cents ELSE 0 END) as revenue_cents
      FROM shopify_orders
      WHERE organization_id = ?
        AND shopify_created_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY strftime('%Y-%m-%d %H:00:00', shopify_created_at)
      ORDER BY bucket ASC
    `).bind(orgId, hours).all<{
      bucket: string;
      conversions: number;
      revenue_cents: number;
    }>();

    return result.results.map(row => ({
      bucket: row.bucket,
      conversions: row.conversions,
      revenue: row.revenue_cents / 100,
    }));
  }

  /**
   * Get combined real-time revenue from all sources (Stripe + Shopify)
   * Respects disabled_conversion_sources setting
   */
  async getCombinedRealtimeSummary(
    orgId: string,
    hours: number = 24,
    disabledSources: string[] = []
  ): Promise<CombinedRealtimeSummary> {
    const sources: CombinedRealtimeSummary['sources'] = {};
    let totalConversions = 0;
    let totalRevenue = 0;
    let totalCustomers = 0;

    // Get Stripe data if not disabled
    if (!disabledSources.includes('stripe')) {
      try {
        const stripeData = await this.getStripeRealtimeSummary(orgId, hours);
        if (stripeData.conversions > 0 || stripeData.revenue > 0) {
          sources.stripe = { conversions: stripeData.conversions, revenue: stripeData.revenue };
          totalConversions += stripeData.conversions;
          totalRevenue += stripeData.revenue;
          totalCustomers += stripeData.uniqueCustomers;
        }
      } catch (e) {
        // Stripe table may not exist or have data
      }
    }

    // Get Shopify data if not disabled
    if (!disabledSources.includes('shopify')) {
      try {
        const shopifyData = await this.getShopifyRealtimeSummary(orgId, hours);
        if (shopifyData.conversions > 0 || shopifyData.revenue > 0) {
          sources.shopify = { conversions: shopifyData.conversions, revenue: shopifyData.revenue };
          totalConversions += shopifyData.conversions;
          totalRevenue += shopifyData.revenue;
          totalCustomers += shopifyData.uniqueCustomers;
        }
      } catch (e) {
        // Shopify table may not exist or have data
      }
    }

    return {
      conversions: totalConversions,
      revenue: totalRevenue,
      uniqueCustomers: totalCustomers,
      sources,
    };
  }
}

// =============================================================================
// STRIPE INTERFACES
// =============================================================================

export interface StripeChargeRow {
  id: string;
  organization_id: string;
  connection_id: string;
  charge_id: string;
  customer_id: string | null;
  customer_email_hash: string | null;
  has_invoice: number;
  amount_cents: number;
  currency: string;
  status: string;
  payment_method_type: string | null;
  stripe_created_at: string;
  metadata: string | null;
  raw_data: string | null;
  created_at: string;
}

export interface StripeDailySummaryRow {
  id: number;
  organization_id: string;
  summary_date: string;
  total_charges: number;
  total_amount_cents: number;
  successful_charges: number;
  failed_charges: number;
  refunded_amount_cents: number;
  unique_customers: number;
  created_at: string;
}

export interface StripeSummary {
  total_revenue: number;
  total_units: number;
  transaction_count: number;
  unique_customers: number;
  average_order_value: number;
}

export interface StripeTimeSeriesRow {
  date: string;
  revenue: number;
  transactions: number;
  unique_customers: number;
}

export interface StripeRealtimeSummary {
  conversions: number;
  revenue: number;
  totalCharges: number;
  uniqueCustomers: number;
}

export interface StripeRealtimeTimeSeriesRow {
  bucket: string;
  conversions: number;
  revenue: number;
}

export interface ShopifyRealtimeSummary {
  conversions: number;
  revenue: number;
  totalOrders: number;
  uniqueCustomers: number;
}

export interface ShopifyRealtimeTimeSeriesRow {
  bucket: string;
  conversions: number;
  revenue: number;
}

export interface CombinedRealtimeSummary {
  conversions: number;
  revenue: number;
  uniqueCustomers: number;
  sources: {
    stripe?: { conversions: number; revenue: number };
    shopify?: { conversions: number; revenue: number };
  };
}
