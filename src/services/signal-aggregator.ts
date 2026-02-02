/**
 * Signal Aggregator Service
 *
 * Aggregates attribution signals from multiple data sources (conversions,
 * touchpoints, utm_performance, platform_metrics, tracked_clicks) into a
 * unified SignalSet for attribution analysis.
 *
 * Used by SmartAttributionService and other services that need multi-source
 * signal data without duplicating query logic.
 */

// Aggregated signals from all sources for a single channel/platform
export interface ChannelSignals {
  channel: string;
  platform: string | null;
  medium: string | null;

  // Click-level signals (highest confidence)
  clickIdCount: number;
  clickIdTypes: string[]; // gclid, fbclid, ttclid, etc.

  // UTM signals (tag-based)
  utmSessions: number;
  utmConversions: number;
  utmRevenue: number;

  // Platform-reported signals (ad platform data)
  platformSpend: number;
  platformImpressions: number;
  platformClicks: number;
  platformConversions: number;
  platformRevenue: number;

  // Connector signals (revenue sources)
  connectorConversions: number;
  connectorRevenue: number;
  connectorSource: string | null; // stripe, shopify, jobber

  // Touchpoint signals (tracked clicks table)
  touchpointCount: number;
  firstTouchTimestamp: string | null;
  lastTouchTimestamp: string | null;

  // Comm engagement signals
  emailOpens: number;
  emailClicks: number;
  smsClicks: number;
}

// Full signal set for an organization over a date range
export interface SignalSet {
  orgId: string;
  startDate: string;
  endDate: string;
  channels: ChannelSignals[];
  totals: {
    totalClickIds: number;
    totalUtmSessions: number;
    totalPlatformSpend: number;
    totalConnectorRevenue: number;
    totalTouchpoints: number;
  };
}

/**
 * SignalAggregator - Fetches and merges signals from all available data sources.
 */
export class SignalAggregator {
  private analyticsDb: D1Database;
  private mainDb: D1Database;

  constructor(analyticsDb: D1Database, mainDb: D1Database) {
    this.analyticsDb = analyticsDb;
    this.mainDb = mainDb;
  }

  /**
   * Aggregate all signals for an organization over a date range.
   */
  async aggregate(orgId: string, startDate: string, endDate: string): Promise<SignalSet> {
    const orgTag = await this.getOrgTag(orgId);

    // Fetch all signal sources in parallel
    const [clickIds, utmData, platformData, connectorData, touchpoints, commData] = await Promise.all([
      this.fetchClickIdSignals(orgId, startDate, endDate),
      orgTag ? this.fetchUtmSignals(orgTag, startDate, endDate) : Promise.resolve([]),
      this.fetchPlatformSignals(orgId, startDate, endDate),
      this.fetchConnectorSignals(orgId, startDate, endDate),
      this.fetchTouchpointSignals(orgId, startDate, endDate),
      this.fetchCommEngagementSignals(orgId, startDate, endDate),
    ]);

    // Merge all signals by channel
    const channelMap = new Map<string, ChannelSignals>();

    const getOrCreate = (channel: string, platform: string | null = null, medium: string | null = null): ChannelSignals => {
      if (!channelMap.has(channel)) {
        channelMap.set(channel, {
          channel,
          platform,
          medium,
          clickIdCount: 0,
          clickIdTypes: [],
          utmSessions: 0,
          utmConversions: 0,
          utmRevenue: 0,
          platformSpend: 0,
          platformImpressions: 0,
          platformClicks: 0,
          platformConversions: 0,
          platformRevenue: 0,
          connectorConversions: 0,
          connectorRevenue: 0,
          connectorSource: null,
          touchpointCount: 0,
          firstTouchTimestamp: null,
          lastTouchTimestamp: null,
          emailOpens: 0,
          emailClicks: 0,
          smsClicks: 0,
        });
      }
      return channelMap.get(channel)!;
    };

    // Merge click ID signals
    for (const click of clickIds) {
      const ch = getOrCreate(click.channel, click.platform);
      ch.clickIdCount += click.count;
      if (click.clickIdType && !ch.clickIdTypes.includes(click.clickIdType)) {
        ch.clickIdTypes.push(click.clickIdType);
      }
    }

    // Merge UTM signals
    for (const utm of utmData) {
      const ch = getOrCreate(utm.channel, utm.platform, utm.medium);
      ch.utmSessions += utm.sessions;
      ch.utmConversions += utm.conversions;
      ch.utmRevenue += utm.revenue;
    }

    // Merge platform signals
    for (const plat of platformData) {
      const ch = getOrCreate(plat.channel, plat.platform);
      ch.platformSpend += plat.spend;
      ch.platformImpressions += plat.impressions;
      ch.platformClicks += plat.clicks;
      ch.platformConversions += plat.conversions;
      ch.platformRevenue += plat.revenue;
    }

    // Merge connector signals
    for (const conn of connectorData) {
      const ch = getOrCreate(conn.channel);
      ch.connectorConversions += conn.conversions;
      ch.connectorRevenue += conn.revenue;
      ch.connectorSource = conn.source;
    }

    // Merge touchpoint signals
    for (const tp of touchpoints) {
      const ch = getOrCreate(tp.channel, tp.platform);
      ch.touchpointCount += tp.count;
      if (!ch.firstTouchTimestamp || tp.firstTouch < ch.firstTouchTimestamp) {
        ch.firstTouchTimestamp = tp.firstTouch;
      }
      if (!ch.lastTouchTimestamp || tp.lastTouch > ch.lastTouchTimestamp) {
        ch.lastTouchTimestamp = tp.lastTouch;
      }
    }

    // Merge comm engagement signals
    for (const comm of commData) {
      const ch = getOrCreate(comm.channel);
      ch.emailOpens += comm.emailOpens;
      ch.emailClicks += comm.emailClicks;
      ch.smsClicks += comm.smsClicks;
    }

    const channels = Array.from(channelMap.values());

    return {
      orgId,
      startDate,
      endDate,
      channels,
      totals: {
        totalClickIds: channels.reduce((s, c) => s + c.clickIdCount, 0),
        totalUtmSessions: channels.reduce((s, c) => s + c.utmSessions, 0),
        totalPlatformSpend: channels.reduce((s, c) => s + c.platformSpend, 0),
        totalConnectorRevenue: channels.reduce((s, c) => s + c.connectorRevenue, 0),
        totalTouchpoints: channels.reduce((s, c) => s + c.touchpointCount, 0),
      },
    };
  }

  private async getOrgTag(orgId: string): Promise<string | null> {
    try {
      const result = await this.mainDb.prepare(
        `SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1`
      ).bind(orgId).first<{ short_tag: string }>();
      return result?.short_tag || null;
    } catch (err) {
      console.warn(`[SignalAggregator] Failed to get org tag for ${orgId}:`, err);
      return null;
    }
  }

  private async fetchClickIdSignals(orgId: string, startDate: string, endDate: string) {
    const results: Array<{ channel: string; platform: string; clickIdType: string; count: number }> = [];
    try {
      const rows = await this.analyticsDb.prepare(`
        SELECT click_id_type, platform, COUNT(*) as cnt
        FROM tracked_clicks
        WHERE organization_id = ?
          AND click_id IS NOT NULL
          AND click_timestamp >= ?
          AND click_timestamp <= ?
        GROUP BY click_id_type, platform
      `).bind(orgId, `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`).all<{
        click_id_type: string; platform: string; cnt: number;
      }>();

      for (const r of rows.results || []) {
        const channel = r.platform === 'google' ? 'paid_search'
          : r.platform === 'facebook' || r.platform === 'tiktok' || r.platform === 'snapchat' || r.platform === 'pinterest'
            ? 'paid_social'
            : r.platform || 'unknown';
        results.push({ channel, platform: r.platform, clickIdType: r.click_id_type, count: r.cnt });
      }
    } catch (err) {
      console.warn(`[SignalAggregator] Failed to fetch click ID signals:`, err);
    }
    return results;
  }

  private async fetchUtmSignals(orgTag: string, startDate: string, endDate: string) {
    const results: Array<{ channel: string; platform: string | null; medium: string | null; sessions: number; conversions: number; revenue: number }> = [];
    try {
      const rows = await this.analyticsDb.prepare(`
        SELECT utm_source, utm_medium, SUM(sessions) as sessions, SUM(conversions) as conversions, SUM(revenue_cents) / 100.0 as revenue
        FROM utm_performance
        WHERE org_tag = ? AND date >= ? AND date <= ?
        GROUP BY utm_source, utm_medium
      `).bind(orgTag, startDate, endDate).all<{
        utm_source: string | null; utm_medium: string | null; sessions: number; conversions: number; revenue: number;
      }>();

      for (const r of rows.results || []) {
        const source = r.utm_source || '(direct)';
        const medium = r.utm_medium || '(none)';
        const channel = medium === 'cpc' || medium === 'ppc' ? 'paid_search'
          : medium === 'paid' || medium === 'paid_social' ? 'paid_social'
            : medium === 'email' ? 'email'
              : medium === 'organic' ? 'organic_search'
                : source === '(direct)' ? 'direct'
                  : 'referral';
        results.push({ channel, platform: source === '(direct)' ? null : source, medium, sessions: r.sessions, conversions: r.conversions, revenue: r.revenue });
      }
    } catch (err) {
      console.warn(`[SignalAggregator] Failed to fetch UTM signals:`, err);
    }
    return results;
  }

  private async fetchPlatformSignals(orgId: string, startDate: string, endDate: string) {
    const results: Array<{ channel: string; platform: string; spend: number; impressions: number; clicks: number; conversions: number; revenue: number }> = [];
    try {
      const rows = await this.analyticsDb.prepare(`
        SELECT c.platform,
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.impressions), 0) as impressions,
          COALESCE(SUM(m.clicks), 0) as clicks,
          COALESCE(SUM(m.conversions), 0) as conversions,
          COALESCE(SUM(m.conversion_value_cents), 0) / 100.0 as revenue
        FROM ad_campaigns c
        LEFT JOIN ad_metrics m ON c.id = m.entity_ref AND m.entity_type = 'campaign' AND m.metric_date >= ? AND m.metric_date <= ?
        WHERE c.organization_id = ?
        GROUP BY c.platform
      `).bind(startDate, endDate, orgId).all<{
        platform: string; spend: number; impressions: number; clicks: number; conversions: number; revenue: number;
      }>();

      for (const r of rows.results || []) {
        const channel = r.platform === 'google' ? 'paid_search' : 'paid_social';
        results.push({ channel, platform: r.platform, spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, revenue: r.revenue });
      }
    } catch (err) {
      console.warn(`[SignalAggregator] Failed to fetch platform signals:`, err);
    }
    return results;
  }

  private async fetchConnectorSignals(orgId: string, startDate: string, endDate: string) {
    const results: Array<{ channel: string; source: string; conversions: number; revenue: number }> = [];
    try {
      const rows = await this.analyticsDb.prepare(`
        SELECT conversion_source, COUNT(*) as conversions, COALESCE(SUM(value_cents), 0) / 100.0 as revenue
        FROM conversions
        WHERE organization_id = ?
          AND conversion_source IN ('stripe', 'shopify', 'jobber')
          AND conversion_timestamp >= ?
          AND conversion_timestamp <= ?
        GROUP BY conversion_source
      `).bind(orgId, `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`).all<{
        conversion_source: string; conversions: number; revenue: number;
      }>();

      for (const r of rows.results || []) {
        results.push({ channel: 'revenue', source: r.conversion_source, conversions: r.conversions, revenue: r.revenue });
      }
    } catch (err) {
      console.warn(`[SignalAggregator] Failed to fetch connector signals:`, err);
    }
    return results;
  }

  private async fetchTouchpointSignals(orgId: string, startDate: string, endDate: string) {
    const results: Array<{ channel: string; platform: string; count: number; firstTouch: string; lastTouch: string }> = [];
    try {
      const rows = await this.analyticsDb.prepare(`
        SELECT platform, COUNT(*) as cnt, MIN(click_timestamp) as first_touch, MAX(click_timestamp) as last_touch
        FROM tracked_clicks
        WHERE organization_id = ?
          AND click_timestamp >= ?
          AND click_timestamp <= ?
        GROUP BY platform
      `).bind(orgId, `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`).all<{
        platform: string; cnt: number; first_touch: string; last_touch: string;
      }>();

      for (const r of rows.results || []) {
        const channel = r.platform === 'google' ? 'paid_search' : 'paid_social';
        results.push({ channel, platform: r.platform, count: r.cnt, firstTouch: r.first_touch, lastTouch: r.last_touch });
      }
    } catch (err) {
      console.warn(`[SignalAggregator] Failed to fetch touchpoint signals:`, err);
    }
    return results;
  }

  private async fetchCommEngagementSignals(orgId: string, startDate: string, endDate: string) {
    const results: Array<{ channel: string; emailOpens: number; emailClicks: number; smsClicks: number }> = [];
    try {
      const rows = await this.analyticsDb.prepare(`
        SELECT engagement_type, COUNT(*) as cnt
        FROM comm_engagements
        WHERE organization_id = ?
          AND engagement_timestamp >= ?
          AND engagement_timestamp <= ?
          AND engagement_type IN ('email_open', 'email_click', 'sms_click')
        GROUP BY engagement_type
      `).bind(orgId, `${startDate}T00:00:00Z`, `${endDate}T23:59:59Z`).all<{
        engagement_type: string; cnt: number;
      }>();

      let emailOpens = 0, emailClicks = 0, smsClicks = 0;
      for (const r of rows.results || []) {
        if (r.engagement_type === 'email_open') emailOpens = r.cnt;
        else if (r.engagement_type === 'email_click') emailClicks = r.cnt;
        else if (r.engagement_type === 'sms_click') smsClicks = r.cnt;
      }

      if (emailOpens + emailClicks > 0) {
        results.push({ channel: 'email', emailOpens, emailClicks, smsClicks: 0 });
      }
      if (smsClicks > 0) {
        results.push({ channel: 'sms', emailOpens: 0, emailClicks: 0, smsClicks });
      }
    } catch (err) {
      console.warn(`[SignalAggregator] Failed to fetch comm engagement signals:`, err);
    }
    return results;
  }
}
