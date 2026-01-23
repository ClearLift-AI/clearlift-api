/**
 * Smart Attribution Service
 *
 * Intelligent attribution weighting that uses BOTH ad platform data AND UTM/tag data
 * to accurately attribute conversions. Handles disagreements between sources using
 * a confidence-based signal hierarchy.
 *
 * Signal Hierarchy (Confidence-Based):
 * 1. Click ID Match (gclid/fbclid/ttclid) - 100% confidence - ground truth
 * 2. UTM matches platform WITH active spend - 95% confidence - corroborated
 * 3. UTM matches platform with NO spend - 90% confidence - platform inactive
 * 4. UTM only (no platform match) - 85% confidence - organic/other
 * 5. Platform-reported only (no tag data) - 70% confidence - only available signal
 * 6. No signals - 0% confidence - Direct/Unattributed
 *
 * Key Principle: Use Best Available Signal - Never dilute with arbitrary splits
 */

// Signal types ordered by confidence
export type SignalType =
  | 'click_id'           // 100% - Click ID match (gclid, fbclid, ttclid)
  | 'utm_with_spend'     // 95%  - UTM matches platform with active spend
  | 'utm_no_spend'       // 90%  - UTM matches platform but no spend in period
  | 'utm_only'           // 85%  - UTM only, no matching platform
  | 'platform_only'      // 70%  - Platform-reported, no tag data
  | 'direct';            // 0%   - No signals (unattributed)

// Data quality levels
export type DataQualityLevel =
  | 'verified'           // Multiple signals agree
  | 'corroborated'       // Two sources agree
  | 'single_source'      // Only one source available
  | 'estimated';         // Probabilistic/inferred

// Signal availability for a channel
export interface SignalAvailability {
  platform: string;
  hasClickIds: boolean;
  clickIdCount: number;
  hasUtmMatches: boolean;
  utmSessionCount: number;
  hasActiveSpend: boolean;
  spendAmount: number;
  hasPlatformReported: boolean;
  platformConversions: number;
  platformRevenue: number;
  hasTagData: boolean;
  tagConversions: number;
  tagRevenue: number;
}

// Smart attribution result for a channel
export interface SmartAttribution {
  channel: string;
  platform: string | null;      // google, facebook, tiktok, or null for organic
  medium: string | null;        // cpc, paid, organic, etc.
  campaign: string | null;
  conversions: number;
  revenue: number;
  confidence: number;           // 0-100
  signalType: SignalType;
  dataQuality: DataQualityLevel;
  signals: SignalAvailability;
  explanation: string;          // Human-readable attribution explanation
}

// UTM source to platform mapping
const UTM_SOURCE_PLATFORMS: Record<string, string> = {
  'google': 'google',
  'google_ads': 'google',
  'googleads': 'google',
  'facebook': 'facebook',
  'fb': 'facebook',
  'meta': 'facebook',
  'instagram': 'facebook',
  'tiktok': 'tiktok',
  'microsoft': 'microsoft',
  'bing': 'microsoft',
  'linkedin': 'linkedin',
  'twitter': 'twitter',
  'x': 'twitter',
  'snapchat': 'snapchat',
  'pinterest': 'pinterest',
};

// Platform metrics from D1
interface PlatformMetrics {
  platform: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
}

// UTM performance data
interface UtmPerformance {
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  sessions: number;
  conversions: number;
  revenue: number;
}

// Connector revenue data
interface ConnectorRevenue {
  source: string;
  conversions: number;
  revenue: number;
}

// Daily connector revenue data
interface DailyConnectorRevenue {
  date: string;
  source: string;
  conversions: number;
  revenue: number;
}

// Daily UTM performance data
interface DailyUtmPerformance {
  date: string;
  utmSource: string;
  utmMedium: string | null;
  sessions: number;
  conversions: number;
  revenue: number;
}

// Daily platform metrics
interface DailyPlatformMetrics {
  date: string;
  platform: string;
  spend: number;
  conversions: number;
  revenue: number;
}

// Funnel position data for weighting
interface FunnelPositionData {
  goalId: string;
  goalName: string;
  funnelPosition: number;
  conversionRate: number;  // Rate of converting to macro conversion
  visitorCount: number;
  byChannel: Record<string, number>;  // Channel -> visitor count at this funnel step
}

// Time series entry for response
export interface SmartAttributionTimeSeriesEntry {
  date: string;
  totalConversions: number;
  totalRevenue: number;
  totalSpend: number;
  channels: {
    channel: string;
    conversions: number;
    revenue: number;
    spend: number;
  }[];
}

/**
 * SmartAttributionService
 *
 * Queries multiple data sources and applies signal hierarchy for attribution.
 */
export class SmartAttributionService {
  private analyticsDb: D1Database;
  private mainDb: D1Database;

  constructor(analyticsDb: D1Database, mainDb: D1Database) {
    this.analyticsDb = analyticsDb;
    this.mainDb = mainDb;
  }

  /**
   * Get smart attribution for an organization
   */
  async getSmartAttribution(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<{
    attributions: SmartAttribution[];
    summary: {
      totalConversions: number;
      totalRevenue: number;
      dataCompleteness: number;
      signalBreakdown: Record<SignalType, { count: number; percentage: number }>;
    };
    timeSeries: SmartAttributionTimeSeriesEntry[];
    dataQuality: {
      hasPlatformData: boolean;
      hasTagData: boolean;
      hasClickIds: boolean;
      hasConnectorData: boolean;
      recommendations: string[];
    };
  }> {
    console.log(`[SmartAttribution] Starting for org=${orgId}, ${startDate} to ${endDate}`);

    // Get org_tag for analytics tables
    const orgTag = await this.getOrgTag(orgId);
    console.log(`[SmartAttribution] Resolved org_tag=${orgTag}`);

    // Fetch all data sources in parallel (both aggregate and daily)
    const [
      platformMetrics,
      utmPerformance,
      connectorRevenue,
      dailyUtmPerformance,
      dailyConnectorRevenue,
      dailyPlatformMetrics,
      clickIdStats,
      funnelData,
    ] = await Promise.all([
      this.getPlatformMetrics(orgId, startDate, endDate),
      orgTag ? this.getUtmPerformance(orgTag, startDate, endDate) : Promise.resolve([]),
      this.getConnectorRevenue(orgId, startDate, endDate),
      orgTag ? this.getDailyUtmPerformance(orgTag, startDate, endDate) : Promise.resolve([]),
      this.getDailyConnectorRevenue(orgId, startDate, endDate),
      this.getDailyPlatformMetrics(orgId, startDate, endDate),
      this.getClickIdStats(orgId, startDate, endDate),
      orgTag ? this.getFunnelPositionData(orgId, orgTag, startDate, endDate) : Promise.resolve([]),
    ]);

    console.log(`[SmartAttribution] Data sources: platforms=${platformMetrics.length}, utm=${utmPerformance.length}, connectors=${connectorRevenue.length}, funnelSteps=${funnelData.length}`);

    // Build attribution using signal hierarchy with funnel weighting
    const attributions = this.buildAttributions(
      platformMetrics,
      utmPerformance,
      connectorRevenue,
      funnelData
    );

    // Calculate summary
    const summary = this.calculateSummary(attributions);

    // Build daily time series
    const timeSeries = this.buildDailyTimeSeries(
      dailyUtmPerformance,
      dailyConnectorRevenue,
      dailyPlatformMetrics,
      startDate,
      endDate
    );

    console.log(`[SmartAttribution] Built time series with ${timeSeries.length} days`);

    // Assess data quality
    const dataQuality = this.assessDataQuality(
      platformMetrics,
      utmPerformance,
      connectorRevenue,
      !!orgTag,
      clickIdStats
    );

    return { attributions, summary, timeSeries, dataQuality };
  }

  /**
   * Get organization tag for analytics tables
   */
  private async getOrgTag(orgId: string): Promise<string | null> {
    try {
      const result = await this.mainDb.prepare(`
        SELECT short_tag FROM org_tag_mappings
        WHERE organization_id = ? AND is_active = 1
      `).bind(orgId).first<{ short_tag: string }>();
      return result?.short_tag || null;
    } catch (err) {
      console.warn('[SmartAttribution] Failed to get org tag:', err);
      return null;
    }
  }

  /**
   * Get platform metrics from D1 ANALYTICS_DB
   */
  private async getPlatformMetrics(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<PlatformMetrics[]> {
    const results: PlatformMetrics[] = [];

    // Query Google Ads
    try {
      const googleResult = await this.analyticsDb.prepare(`
        SELECT
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.impressions), 0) as impressions,
          COALESCE(SUM(m.clicks), 0) as clicks,
          COALESCE(SUM(m.conversions), 0) as conversions,
          COALESCE(SUM(m.conversion_value_cents), 0) / 100.0 as revenue
        FROM google_campaigns c
        LEFT JOIN google_campaign_daily_metrics m
          ON c.id = m.campaign_ref
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        WHERE c.organization_id = ?
      `).bind(startDate, endDate, orgId).first<{
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        revenue: number;
      }>();

      if (googleResult && (googleResult.spend > 0 || googleResult.conversions > 0)) {
        results.push({
          platform: 'google',
          spend: googleResult.spend || 0,
          impressions: googleResult.impressions || 0,
          clicks: googleResult.clicks || 0,
          conversions: googleResult.conversions || 0,
          revenue: googleResult.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query google:', err);
    }

    // Query Facebook Ads
    try {
      const facebookResult = await this.analyticsDb.prepare(`
        SELECT
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.impressions), 0) as impressions,
          COALESCE(SUM(m.clicks), 0) as clicks,
          COALESCE(SUM(m.conversions), 0) as conversions,
          0 as revenue
        FROM facebook_campaigns c
        LEFT JOIN facebook_campaign_daily_metrics m
          ON c.id = m.campaign_ref
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        WHERE c.organization_id = ?
      `).bind(startDate, endDate, orgId).first<{
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        revenue: number;
      }>();

      if (facebookResult && (facebookResult.spend > 0 || facebookResult.conversions > 0)) {
        results.push({
          platform: 'facebook',
          spend: facebookResult.spend || 0,
          impressions: facebookResult.impressions || 0,
          clicks: facebookResult.clicks || 0,
          conversions: facebookResult.conversions || 0,
          revenue: facebookResult.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query facebook:', err);
    }

    // Query TikTok Ads
    try {
      const tiktokResult = await this.analyticsDb.prepare(`
        SELECT
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.impressions), 0) as impressions,
          COALESCE(SUM(m.clicks), 0) as clicks,
          COALESCE(SUM(m.conversions), 0) as conversions,
          COALESCE(SUM(m.conversion_value_cents), 0) / 100.0 as revenue
        FROM tiktok_campaigns c
        LEFT JOIN tiktok_campaign_daily_metrics m
          ON c.id = m.campaign_ref
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        WHERE c.organization_id = ?
      `).bind(startDate, endDate, orgId).first<{
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        revenue: number;
      }>();

      if (tiktokResult && (tiktokResult.spend > 0 || tiktokResult.conversions > 0)) {
        results.push({
          platform: 'tiktok',
          spend: tiktokResult.spend || 0,
          impressions: tiktokResult.impressions || 0,
          clicks: tiktokResult.clicks || 0,
          conversions: tiktokResult.conversions || 0,
          revenue: tiktokResult.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query tiktok:', err);
    }

    return results;
  }

  /**
   * Get UTM performance from D1 utm_performance table
   * Note: Uses org_tag, not organization_id
   * Includes DIRECT traffic (null/empty utm_source) as a separate channel
   */
  private async getUtmPerformance(
    orgTag: string,
    startDate: string,
    endDate: string
  ): Promise<UtmPerformance[]> {
    const results: UtmPerformance[] = [];

    // Get UTM-attributed sessions
    try {
      const utmResult = await this.analyticsDb.prepare(`
        SELECT
          utm_source,
          utm_medium,
          utm_campaign,
          SUM(sessions) as sessions,
          SUM(conversions) as conversions,
          SUM(revenue_cents) / 100.0 as revenue
        FROM utm_performance
        WHERE org_tag = ?
          AND date >= ?
          AND date <= ?
          AND utm_source IS NOT NULL
          AND utm_source != ''
        GROUP BY utm_source, utm_medium, utm_campaign
        ORDER BY SUM(sessions) DESC
        LIMIT 100
      `).bind(orgTag, startDate, endDate).all<{
        utm_source: string;
        utm_medium: string | null;
        utm_campaign: string | null;
        sessions: number;
        conversions: number;
        revenue: number;
      }>();

      for (const r of utmResult.results || []) {
        results.push({
          utmSource: r.utm_source,
          utmMedium: r.utm_medium,
          utmCampaign: r.utm_campaign,
          sessions: r.sessions || 0,
          conversions: r.conversions || 0,
          revenue: r.revenue || 0
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query UTM performance:', err);
    }

    // Get DIRECT traffic (sessions without UTM source)
    try {
      const directResult = await this.analyticsDb.prepare(`
        SELECT
          SUM(sessions) as sessions,
          SUM(conversions) as conversions,
          SUM(revenue_cents) / 100.0 as revenue
        FROM utm_performance
        WHERE org_tag = ?
          AND date >= ?
          AND date <= ?
          AND (utm_source IS NULL OR utm_source = '')
      `).bind(orgTag, startDate, endDate).first<{
        sessions: number;
        conversions: number;
        revenue: number;
      }>();

      if (directResult && directResult.sessions > 0) {
        results.push({
          utmSource: '(direct)',
          utmMedium: '(none)',
          utmCampaign: null,
          sessions: directResult.sessions || 0,
          conversions: directResult.conversions || 0,
          revenue: directResult.revenue || 0
        });
        console.log(`[SmartAttribution] Direct traffic: ${directResult.sessions} sessions, ${directResult.conversions} conversions`);
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query direct traffic:', err);
    }

    return results;
  }

  /**
   * Get connector revenue (Stripe, Shopify, etc.)
   */
  private async getConnectorRevenue(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<ConnectorRevenue[]> {
    const results: ConnectorRevenue[] = [];

    // Query Stripe - only count actual CONVERSIONS (new subscriptions/purchases)
    // - subscription_create: New subscription (first payment)
    // - NULL billing_reason with succeeded status: One-time charge
    // Do NOT count subscription_cycle (renewals) as conversions
    try {
      const stripeResult = await this.analyticsDb.prepare(`
        SELECT
          COUNT(*) as conversions,
          COALESCE(SUM(amount_cents), 0) / 100.0 as revenue
        FROM stripe_charges
        WHERE organization_id = ?
          AND DATE(stripe_created_at) >= ?
          AND DATE(stripe_created_at) <= ?
          AND (
            billing_reason = 'subscription_create'
            OR (billing_reason IS NULL AND status = 'succeeded')
          )
      `).bind(orgId, startDate, endDate).first<{
        conversions: number;
        revenue: number;
      }>();

      if (stripeResult && stripeResult.conversions > 0) {
        results.push({
          source: 'stripe',
          conversions: stripeResult.conversions,
          revenue: stripeResult.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query Stripe revenue:', err);
    }

    // Query Shopify if available
    try {
      const shopifyResult = await this.analyticsDb.prepare(`
        SELECT
          COUNT(*) as conversions,
          COALESCE(SUM(total_price_cents), 0) / 100.0 as revenue
        FROM shopify_orders
        WHERE organization_id = ?
          AND DATE(created_at) >= ?
          AND DATE(created_at) <= ?
      `).bind(orgId, startDate, endDate).first<{
        conversions: number;
        revenue: number;
      }>();

      if (shopifyResult && shopifyResult.conversions > 0) {
        results.push({
          source: 'shopify',
          conversions: shopifyResult.conversions,
          revenue: shopifyResult.revenue || 0,
        });
      }
    } catch (err) {
      // Table might not exist
    }

    return results;
  }

  /**
   * Get funnel position data for weighting attribution
   * Sessions that reached higher funnel positions (closer to conversion) get more credit
   *
   * This uses the same data sources as flow-metrics for consistency:
   * - conversion_goals table for stage definitions
   * - daily_metrics.by_channel for channel breakdown
   * - Ad platform / connector queries for actual visitors per stage
   */
  private async getFunnelPositionData(
    orgId: string,
    orgTag: string,
    startDate: string,
    endDate: string
  ): Promise<FunnelPositionData[]> {
    try {
      // Get all goals/stages with their positions
      const goalsResult = await this.mainDb.prepare(`
        SELECT
          id, name, type, connector, connector_event_type,
          COALESCE(position_row, priority, 0) as position_row,
          COALESCE(position_col, 0) as position_col,
          is_conversion
        FROM conversion_goals
        WHERE organization_id = ? AND is_active = 1
        ORDER BY position_row ASC, position_col ASC
      `).bind(orgId).all<{
        id: string;
        name: string;
        type: string;
        connector: string | null;
        connector_event_type: string | null;
        position_row: number;
        position_col: number;
        is_conversion: number | null;
      }>();

      const goals = goalsResult.results || [];
      if (goals.length === 0) {
        return [];
      }

      // Get channel distribution from daily_metrics
      const channelResult = await this.analyticsDb.prepare(`
        SELECT by_channel FROM daily_metrics
        WHERE org_tag = ? AND date >= ? AND date <= ?
      `).bind(orgTag, startDate.split('T')[0], endDate.split('T')[0]).all<{ by_channel: string | null }>();

      // Aggregate channel distribution
      const channelDistribution: Record<string, number> = {};
      let totalChannelEvents = 0;
      for (const row of channelResult.results || []) {
        if (row.by_channel) {
          try {
            const channels = JSON.parse(row.by_channel) as Record<string, number>;
            for (const [channel, count] of Object.entries(channels)) {
              channelDistribution[channel] = (channelDistribution[channel] || 0) + count;
              totalChannelEvents += count;
            }
          } catch {}
        }
      }

      const funnelData: FunnelPositionData[] = [];
      const maxRow = Math.max(...goals.map(g => g.position_row), 0);

      for (const goal of goals) {
        const connector = goal.connector || 'clearlift_tag';
        let visitors = 0;

        // Query visitors based on connector type (same logic as flow-metrics)
        try {
          if (connector === 'google_ads') {
            const result = await this.analyticsDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM google_campaigns c
              LEFT JOIN google_campaign_daily_metrics m
                ON c.id = m.campaign_ref AND m.metric_date >= ? AND m.metric_date <= ?
              WHERE c.organization_id = ?
            `).bind(startDate, endDate, orgId).first<{ clicks: number }>();
            visitors = result?.clicks || 0;
          } else if (connector === 'facebook_ads') {
            const result = await this.analyticsDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM facebook_campaigns c
              LEFT JOIN facebook_campaign_daily_metrics m
                ON c.id = m.campaign_ref AND m.metric_date >= ? AND m.metric_date <= ?
              WHERE c.organization_id = ?
            `).bind(startDate, endDate, orgId).first<{ clicks: number }>();
            visitors = result?.clicks || 0;
          } else if (connector === 'stripe') {
            const result = await this.analyticsDb.prepare(`
              SELECT COUNT(*) as conversions FROM stripe_charges
              WHERE organization_id = ? AND DATE(stripe_created_at) >= ? AND DATE(stripe_created_at) <= ?
                AND (billing_reason = 'subscription_create' OR (billing_reason IS NULL AND status = 'succeeded'))
            `).bind(orgId, startDate, endDate).first<{ conversions: number }>();
            visitors = result?.conversions || 0;
          } else if (connector === 'shopify') {
            const result = await this.analyticsDb.prepare(`
              SELECT COUNT(*) as conversions FROM shopify_orders
              WHERE organization_id = ? AND DATE(created_at) >= ? AND DATE(created_at) <= ?
            `).bind(orgId, startDate, endDate).first<{ conversions: number }>();
            visitors = result?.conversions || 0;
          }
        } catch {}

        // Build by_channel for this goal
        const byChannel: Record<string, number> = {};
        if (visitors > 0) {
          if (connector === 'google_ads') {
            byChannel['paid_search'] = visitors;
          } else if (connector === 'facebook_ads' || connector === 'tiktok_ads') {
            byChannel['paid_social'] = visitors;
          } else if (totalChannelEvents > 0) {
            // Distribute based on channel proportions
            for (const [channel, eventCount] of Object.entries(channelDistribution)) {
              const ratio = eventCount / totalChannelEvents;
              const attributed = Math.round(visitors * ratio);
              if (attributed > 0) {
                byChannel[channel] = attributed;
              }
            }
          }
        }

        // Funnel position = inverted row (higher row = closer to conversion = higher position)
        // Position 0 = top of funnel, maxRow = bottom (conversion)
        const funnelPosition = maxRow - goal.position_row + 1;

        // Conversion rate approximation: stages closer to conversion get higher rate
        const conversionRate = goal.is_conversion ? 1.0 : (funnelPosition / (maxRow + 1));

        funnelData.push({
          goalId: goal.id,
          goalName: goal.name,
          funnelPosition,
          conversionRate,
          visitorCount: visitors,
          byChannel,
        });
      }

      // Sort by funnel position (higher = closer to conversion)
      funnelData.sort((a, b) => b.funnelPosition - a.funnelPosition);

      console.log(`[SmartAttribution] Funnel data: ${funnelData.length} goals from flow builder`);
      return funnelData;
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query funnel position data:', err);
      return [];
    }
  }

  /**
   * Get click ID statistics from conversions table
   * Checks for gclid, fbclid, ttclid in the conversions
   */
  private async getClickIdStats(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<{ hasClickIds: boolean; clickIdCount: number; byType: Record<string, number> }> {
    try {
      const result = await this.analyticsDb.prepare(`
        SELECT
          click_id_type,
          COUNT(*) as count
        FROM conversions
        WHERE organization_id = ?
          AND conversion_timestamp >= ?
          AND conversion_timestamp <= ?
          AND click_id IS NOT NULL
          AND click_id_type IS NOT NULL
        GROUP BY click_id_type
      `).bind(orgId, startDate, endDate + 'T23:59:59Z').all();

      const rows = (result.results || []) as Array<{ click_id_type: string; count: number }>;
      const byType: Record<string, number> = {};
      let clickIdCount = 0;

      for (const row of rows) {
        byType[row.click_id_type] = row.count;
        clickIdCount += row.count;
      }

      return {
        hasClickIds: clickIdCount > 0,
        clickIdCount,
        byType
      };
    } catch (err) {
      // Table might not exist or have different schema
      console.warn('[SmartAttribution] Failed to query click ID stats:', err);
      return { hasClickIds: false, clickIdCount: 0, byType: {} };
    }
  }

  /**
   * Build attributions using signal hierarchy with funnel weighting
   *
   * Key insight: When we have connector revenue (Stripe/Shopify) but no direct
   * click-level attribution, we probabilistically distribute the revenue based
   * on session share WEIGHTED by funnel position. Sessions that reached higher
   * funnel positions (closer to conversion) get proportionally more credit.
   *
   * Funnel Weight Formula:
   *   weight = sessionShare × (1 + funnelBonus)
   *   where funnelBonus = Σ(position × conversionRate) for all reached funnel steps
   */
  private buildAttributions(
    platformMetrics: PlatformMetrics[],
    utmPerformance: UtmPerformance[],
    connectorRevenue: ConnectorRevenue[],
    funnelData: FunnelPositionData[] = []
  ): SmartAttribution[] {
    const attributions: SmartAttribution[] = [];

    // Calculate total connector revenue (ground truth for conversions)
    const totalConnectorConversions = connectorRevenue.reduce((sum, c) => sum + c.conversions, 0);
    const totalConnectorRevenue = connectorRevenue.reduce((sum, c) => sum + c.revenue, 0);
    const hasConnectorData = totalConnectorConversions > 0;

    console.log(`[SmartAttribution] Connector totals: ${totalConnectorConversions} conversions, $${totalConnectorRevenue}`);

    // Create lookup maps for platform data
    const platformSpendByName = new Map<string, number>();
    const platformConversionsByName = new Map<string, number>();
    const platformRevenueByName = new Map<string, number>();
    for (const pm of platformMetrics) {
      platformSpendByName.set(pm.platform, pm.spend);
      platformConversionsByName.set(pm.platform, pm.conversions);
      platformRevenueByName.set(pm.platform, pm.revenue);
    }

    // Aggregate UTM data by normalized channel (platform or lowercase source)
    // This merges "facebook", "fb", "meta" into single "facebook" entry
    const aggregatedUtm = new Map<string, {
      channel: string;
      platform: string | null;
      medium: string | null;
      campaign: string | null;
      sessions: number;
      conversions: number;
      revenue: number;
      sources: string[];
    }>();

    let totalUtmSessions = 0;

    for (const utm of utmPerformance) {
      const sourceLower = utm.utmSource.toLowerCase().trim();

      // Handle direct traffic specially
      const isDirect = sourceLower === '(direct)' || sourceLower === 'direct' || sourceLower === '';
      const matchedPlatform = isDirect ? null : UTM_SOURCE_PLATFORMS[sourceLower];
      const channelKey = isDirect ? 'direct' : (matchedPlatform || sourceLower);

      totalUtmSessions += utm.sessions;

      const existing = aggregatedUtm.get(channelKey);
      if (existing) {
        existing.sessions += utm.sessions;
        existing.conversions += utm.conversions;
        existing.revenue += utm.revenue;
        if (!existing.sources.includes(utm.utmSource)) {
          existing.sources.push(utm.utmSource);
        }
        if (!existing.medium && utm.utmMedium) existing.medium = utm.utmMedium;
        if (!existing.campaign && utm.utmCampaign) existing.campaign = utm.utmCampaign;
      } else {
        aggregatedUtm.set(channelKey, {
          channel: isDirect ? 'Direct' : (matchedPlatform || utm.utmSource),
          platform: matchedPlatform || null,
          medium: isDirect ? '(none)' : utm.utmMedium,
          campaign: utm.utmCampaign,
          sessions: utm.sessions,
          conversions: utm.conversions,
          revenue: utm.revenue,
          sources: [utm.utmSource],
        });
      }
    }

    console.log(`[SmartAttribution] Total UTM sessions: ${totalUtmSessions}, channels: ${aggregatedUtm.size}`);

    // Track which platforms have been processed via UTM
    const processedPlatforms = new Set<string>();

    // Probabilistic distribution: When we have connector revenue but UTM data
    // doesn't have conversions, distribute based on session share
    const useSessionBasedDistribution = hasConnectorData && totalUtmSessions > 0;

    // Build funnel bonus lookup by channel
    // Channels with visitors at higher funnel positions get bonus weighting
    const funnelBonusByChannel = new Map<string, { bonus: number; maxPosition: number; steps: string[] }>();
    if (funnelData.length > 0) {
      for (const funnelStep of funnelData) {
        for (const [channel, visitorCount] of Object.entries(funnelStep.byChannel)) {
          const normalizedChannel = channel.toLowerCase();
          const existing = funnelBonusByChannel.get(normalizedChannel) || { bonus: 0, maxPosition: 0, steps: [] };

          // Add bonus based on funnel position × conversion rate
          // Position 3 with 50% conversion rate = 1.5 bonus points
          const stepBonus = funnelStep.funnelPosition * funnelStep.conversionRate;
          existing.bonus += stepBonus;
          existing.maxPosition = Math.max(existing.maxPosition, funnelStep.funnelPosition);
          if (!existing.steps.includes(funnelStep.goalName)) {
            existing.steps.push(funnelStep.goalName);
          }

          funnelBonusByChannel.set(normalizedChannel, existing);
        }
      }
      console.log(`[SmartAttribution] Funnel bonuses computed for ${funnelBonusByChannel.size} channels`);
    }

    // Calculate total weighted sessions (for normalization)
    let totalWeightedSessions = 0;
    const channelWeights = new Map<string, number>();
    for (const [channelKey, utm] of aggregatedUtm) {
      const bonus = funnelBonusByChannel.get(channelKey.toLowerCase())?.bonus || 0;
      const weight = utm.sessions * (1 + bonus);
      channelWeights.set(channelKey, weight);
      totalWeightedSessions += weight;
    }

    // Build attributions from UTM data
    for (const [channelKey, utm] of aggregatedUtm) {
      const matchedPlatform = utm.platform;

      if (matchedPlatform) {
        processedPlatforms.add(matchedPlatform);
      }

      const platformSpend = matchedPlatform ? (platformSpendByName.get(matchedPlatform) || 0) : 0;
      const hasActiveSpend = platformSpend > 0;
      const hasPlatformMatch = !!matchedPlatform && platformConversionsByName.has(matchedPlatform);

      // Calculate session share for probabilistic attribution
      // Use funnel-weighted share if funnel data available, otherwise use raw sessions
      const channelWeight = channelWeights.get(channelKey) || utm.sessions;
      const sessionShare = totalWeightedSessions > 0
        ? channelWeight / totalWeightedSessions
        : (totalUtmSessions > 0 ? utm.sessions / totalUtmSessions : 0);

      // Get funnel info for this channel
      const funnelInfo = funnelBonusByChannel.get(channelKey.toLowerCase());

      // Determine conversions and revenue
      let conversions: number;
      let revenue: number;
      let signalType: SignalType;
      let confidence: number;
      let dataQuality: DataQualityLevel;
      let explanation: string;

      const sourcesList = utm.sources.length > 1
        ? utm.sources.slice(0, 3).join(', ') + (utm.sources.length > 3 ? '...' : '')
        : utm.sources[0];

      // Build funnel explanation suffix if channel has funnel data
      let funnelSuffix = '';
      if (funnelInfo && funnelInfo.steps.length > 0) {
        const stepsText = funnelInfo.steps.slice(0, 2).join(', ');
        funnelSuffix = ` Funnel-weighted: reached ${stepsText}${funnelInfo.steps.length > 2 ? '...' : ''}.`;
      }

      // If UTM has direct conversions, use those
      if (utm.conversions > 0) {
        conversions = utm.conversions;
        revenue = utm.revenue;

        if (matchedPlatform && hasActiveSpend) {
          signalType = 'utm_with_spend';
          confidence = 95;
          dataQuality = 'corroborated';
          explanation = `${conversions} tracked conversion(s). UTM "${sourcesList}" matches ${matchedPlatform} with $${platformSpend.toFixed(0)} spend.${funnelSuffix}`;
        } else if (matchedPlatform) {
          signalType = 'utm_no_spend';
          confidence = 90;
          dataQuality = 'single_source';
          explanation = `${conversions} tracked conversion(s). UTM "${sourcesList}" matches ${matchedPlatform}, no active spend.${funnelSuffix}`;
        } else {
          signalType = 'utm_only';
          confidence = 85;
          dataQuality = 'single_source';
          explanation = `${conversions} tracked conversion(s) from "${sourcesList}".${funnelSuffix}`;
        }
      }
      // Otherwise, probabilistically distribute connector revenue based on session share
      else if (useSessionBasedDistribution && sessionShare > 0) {
        conversions = Math.round(totalConnectorConversions * sessionShare * 100) / 100;
        revenue = Math.round(totalConnectorRevenue * sessionShare * 100) / 100;

        // Build share explanation - mention funnel weighting if applied
        const shareExplanation = funnelInfo && funnelInfo.bonus > 0
          ? `${(sessionShare * 100).toFixed(1)}% funnel-weighted share`
          : `${(sessionShare * 100).toFixed(1)}% of sessions`;

        if (matchedPlatform && hasActiveSpend) {
          signalType = 'utm_with_spend';
          confidence = funnelInfo && funnelInfo.bonus > 0 ? 80 : 75; // Slightly higher confidence with funnel data
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${shareExplanation}). UTM "${sourcesList}" + ${matchedPlatform} spend corroborates.${funnelSuffix}`;
        } else if (matchedPlatform) {
          signalType = 'utm_no_spend';
          confidence = funnelInfo && funnelInfo.bonus > 0 ? 75 : 70;
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${shareExplanation}). UTM "${sourcesList}" matches ${matchedPlatform}.${funnelSuffix}`;
        } else {
          signalType = 'utm_only';
          confidence = funnelInfo && funnelInfo.bonus > 0 ? 70 : 65;
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${shareExplanation}) from "${sourcesList}".${funnelSuffix}`;
        }
      } else {
        // No conversions and no connector data to distribute
        conversions = 0;
        revenue = 0;
        signalType = 'utm_only';
        confidence = 50;
        dataQuality = 'estimated';
        explanation = `${utm.sessions} sessions from "${sourcesList}", no conversion data available.`;
      }

      // Only add if there are sessions or conversions
      if (utm.sessions > 0 || conversions > 0) {
        attributions.push({
          channel: utm.channel,
          platform: matchedPlatform,
          medium: utm.medium,
          campaign: utm.campaign,
          conversions,
          revenue,
          confidence,
          signalType,
          dataQuality,
          signals: {
            platform: matchedPlatform || utm.channel,
            hasClickIds: false,
            clickIdCount: 0,
            hasUtmMatches: true,
            utmSessionCount: utm.sessions,
            hasActiveSpend,
            spendAmount: platformSpend,
            hasPlatformReported: hasPlatformMatch,
            platformConversions: matchedPlatform ? (platformConversionsByName.get(matchedPlatform) || 0) : 0,
            platformRevenue: matchedPlatform ? (platformRevenueByName.get(matchedPlatform) || 0) : 0,
            hasTagData: true,
            tagConversions: utm.conversions,
            tagRevenue: utm.revenue
          },
          explanation
        });
      }
    }

    // Priority 5: Platform-only data (70% confidence)
    // Only add platforms that haven't been attributed via UTMs
    for (const pm of platformMetrics) {
      if (processedPlatforms.has(pm.platform)) continue;

      if (pm.conversions > 0 || pm.spend > 0) {
        attributions.push({
          channel: pm.platform,
          platform: pm.platform,
          medium: pm.platform === 'google' ? 'cpc' : 'paid',
          campaign: null,
          conversions: pm.conversions,
          revenue: pm.revenue,
          confidence: 70,
          signalType: 'platform_only',
          dataQuality: 'single_source',
          signals: {
            platform: pm.platform,
            hasClickIds: false,
            clickIdCount: 0,
            hasUtmMatches: false,
            utmSessionCount: 0,
            hasActiveSpend: pm.spend > 0,
            spendAmount: pm.spend,
            hasPlatformReported: true,
            platformConversions: pm.conversions,
            platformRevenue: pm.revenue,
            hasTagData: false,
            tagConversions: 0,
            tagRevenue: 0
          },
          explanation: `Platform self-reported ${pm.conversions} conversion(s) with $${pm.spend.toFixed(0)} spend. No tag verification.`
        });
      }
    }

    // Add unattributed/direct if there's leftover connector revenue
    const totalAttributedConversions = attributions.reduce((sum, a) => sum + a.conversions, 0);
    const totalAttributedRevenue = attributions.reduce((sum, a) => sum + a.revenue, 0);

    // Account for sessions without UTM (direct traffic)
    // If we have connector conversions but didn't distribute all of them
    if (hasConnectorData) {
      const unattributedConversions = Math.max(0, totalConnectorConversions - totalAttributedConversions);
      const unattributedRevenue = Math.max(0, totalConnectorRevenue - totalAttributedRevenue);

      if (unattributedConversions > 0.5 || unattributedRevenue > 1) {
        attributions.push({
          channel: 'direct',
          platform: null,
          medium: 'none',
          campaign: null,
          conversions: Math.round(unattributedConversions * 100) / 100,
          revenue: Math.round(unattributedRevenue * 100) / 100,
          confidence: 0,
          signalType: 'direct',
          dataQuality: 'estimated',
          signals: {
            platform: 'direct',
            hasClickIds: false,
            clickIdCount: 0,
            hasUtmMatches: false,
            utmSessionCount: 0,
            hasActiveSpend: false,
            spendAmount: 0,
            hasPlatformReported: false,
            platformConversions: 0,
            platformRevenue: 0,
            hasTagData: false,
            tagConversions: 0,
            tagRevenue: 0
          },
          explanation: `${unattributedConversions.toFixed(1)} conversion(s) without UTM tracking. Direct traffic or missing attribution.`
        });
      }
    }

    // Sort by revenue DESC (most valuable channels first), then confidence
    attributions.sort((a, b) => {
      if (b.revenue !== a.revenue) return b.revenue - a.revenue;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.conversions - a.conversions;
    });

    return attributions;
  }

  /**
   * Calculate summary metrics
   */
  private calculateSummary(attributions: SmartAttribution[]): {
    totalConversions: number;
    totalRevenue: number;
    dataCompleteness: number;
    signalBreakdown: Record<SignalType, { count: number; percentage: number }>;
  } {
    const totalConversions = attributions.reduce((sum, a) => sum + a.conversions, 0);
    const totalRevenue = attributions.reduce((sum, a) => sum + a.revenue, 0);

    // Calculate signal breakdown
    const signalCounts: Record<SignalType, number> = {
      click_id: 0,
      utm_with_spend: 0,
      utm_no_spend: 0,
      utm_only: 0,
      platform_only: 0,
      direct: 0
    };

    for (const attr of attributions) {
      signalCounts[attr.signalType] += attr.conversions;
    }

    const signalBreakdown: Record<SignalType, { count: number; percentage: number }> = {} as any;
    for (const [signal, count] of Object.entries(signalCounts)) {
      signalBreakdown[signal as SignalType] = {
        count,
        percentage: totalConversions > 0 ? Math.round((count / totalConversions) * 100) : 0
      };
    }

    // Data completeness = percentage of conversions NOT in platform_only or direct
    const highConfidenceConversions = attributions
      .filter(a => a.signalType !== 'platform_only' && a.signalType !== 'direct')
      .reduce((sum, a) => sum + a.conversions, 0);
    const dataCompleteness = totalConversions > 0
      ? Math.round((highConfidenceConversions / totalConversions) * 100)
      : 0;

    return {
      totalConversions,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      dataCompleteness,
      signalBreakdown
    };
  }

  /**
   * Get daily UTM performance grouped by date and source
   */
  private async getDailyUtmPerformance(
    orgTag: string,
    startDate: string,
    endDate: string
  ): Promise<DailyUtmPerformance[]> {
    const results: DailyUtmPerformance[] = [];

    try {
      // Get UTM data grouped by date and source
      const utmResult = await this.analyticsDb.prepare(`
        SELECT
          date,
          utm_source,
          utm_medium,
          SUM(sessions) as sessions,
          SUM(conversions) as conversions,
          SUM(revenue_cents) / 100.0 as revenue
        FROM utm_performance
        WHERE org_tag = ?
          AND date >= ?
          AND date <= ?
        GROUP BY date, utm_source, utm_medium
        ORDER BY date, sessions DESC
      `).bind(orgTag, startDate, endDate).all<{
        date: string;
        utm_source: string | null;
        utm_medium: string | null;
        sessions: number;
        conversions: number;
        revenue: number;
      }>();

      for (const r of utmResult.results || []) {
        results.push({
          date: r.date,
          utmSource: r.utm_source || '(direct)',
          utmMedium: r.utm_medium,
          sessions: r.sessions || 0,
          conversions: r.conversions || 0,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query daily UTM performance:', err);
    }

    return results;
  }

  /**
   * Get daily connector revenue (Stripe, Shopify) grouped by date
   */
  private async getDailyConnectorRevenue(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<DailyConnectorRevenue[]> {
    const results: DailyConnectorRevenue[] = [];

    // Query Stripe by date - only count actual CONVERSIONS (new subscriptions/purchases)
    // - subscription_create: New subscription (first payment)
    // - NULL billing_reason with succeeded status: One-time charge
    // Do NOT count subscription_cycle (renewals) as conversions
    try {
      const stripeResult = await this.analyticsDb.prepare(`
        SELECT
          DATE(stripe_created_at) as date,
          COUNT(*) as conversions,
          COALESCE(SUM(amount_cents), 0) / 100.0 as revenue
        FROM stripe_charges
        WHERE organization_id = ?
          AND DATE(stripe_created_at) >= ?
          AND DATE(stripe_created_at) <= ?
          AND (
            billing_reason = 'subscription_create'
            OR (billing_reason IS NULL AND status = 'succeeded')
          )
        GROUP BY DATE(stripe_created_at)
        ORDER BY date
      `).bind(orgId, startDate, endDate).all<{
        date: string;
        conversions: number;
        revenue: number;
      }>();

      for (const r of stripeResult.results || []) {
        results.push({
          date: r.date,
          source: 'stripe',
          conversions: r.conversions,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query daily Stripe revenue:', err);
    }

    // Query Shopify by date
    try {
      const shopifyResult = await this.analyticsDb.prepare(`
        SELECT
          DATE(created_at) as date,
          COUNT(*) as conversions,
          COALESCE(SUM(total_price_cents), 0) / 100.0 as revenue
        FROM shopify_orders
        WHERE organization_id = ?
          AND DATE(created_at) >= ?
          AND DATE(created_at) <= ?
        GROUP BY DATE(created_at)
        ORDER BY date
      `).bind(orgId, startDate, endDate).all<{
        date: string;
        conversions: number;
        revenue: number;
      }>();

      for (const r of shopifyResult.results || []) {
        results.push({
          date: r.date,
          source: 'shopify',
          conversions: r.conversions,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      // Table might not exist
    }

    return results;
  }

  /**
   * Get daily platform metrics (spend, conversions) grouped by date
   */
  private async getDailyPlatformMetrics(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<DailyPlatformMetrics[]> {
    const results: DailyPlatformMetrics[] = [];

    // Query Google Ads daily
    try {
      const googleResult = await this.analyticsDb.prepare(`
        SELECT
          m.metric_date as date,
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.conversions), 0) as conversions,
          COALESCE(SUM(m.conversion_value_cents), 0) / 100.0 as revenue
        FROM google_campaigns c
        JOIN google_campaign_daily_metrics m
          ON c.id = m.campaign_ref
        WHERE c.organization_id = ?
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        GROUP BY m.metric_date
        ORDER BY m.metric_date
      `).bind(orgId, startDate, endDate).all<{
        date: string;
        spend: number;
        conversions: number;
        revenue: number;
      }>();

      for (const r of googleResult.results || []) {
        results.push({
          date: r.date,
          platform: 'google',
          spend: r.spend || 0,
          conversions: r.conversions || 0,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query daily google metrics:', err);
    }

    // Query Facebook Ads daily
    try {
      const facebookResult = await this.analyticsDb.prepare(`
        SELECT
          m.metric_date as date,
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.conversions), 0) as conversions,
          0 as revenue
        FROM facebook_campaigns c
        JOIN facebook_campaign_daily_metrics m
          ON c.id = m.campaign_ref
        WHERE c.organization_id = ?
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        GROUP BY m.metric_date
        ORDER BY m.metric_date
      `).bind(orgId, startDate, endDate).all<{
        date: string;
        spend: number;
        conversions: number;
        revenue: number;
      }>();

      for (const r of facebookResult.results || []) {
        results.push({
          date: r.date,
          platform: 'facebook',
          spend: r.spend || 0,
          conversions: r.conversions || 0,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query daily facebook metrics:', err);
    }

    // Query TikTok Ads daily
    try {
      const tiktokResult = await this.analyticsDb.prepare(`
        SELECT
          m.metric_date as date,
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.conversions), 0) as conversions,
          COALESCE(SUM(m.conversion_value_cents), 0) / 100.0 as revenue
        FROM tiktok_campaigns c
        JOIN tiktok_campaign_daily_metrics m
          ON c.id = m.campaign_ref
        WHERE c.organization_id = ?
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        GROUP BY m.metric_date
        ORDER BY m.metric_date
      `).bind(orgId, startDate, endDate).all<{
        date: string;
        spend: number;
        conversions: number;
        revenue: number;
      }>();

      for (const r of tiktokResult.results || []) {
        results.push({
          date: r.date,
          platform: 'tiktok',
          spend: r.spend || 0,
          conversions: r.conversions || 0,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query daily tiktok metrics:', err);
    }

    return results;
  }

  /**
   * Build daily time series from all sources
   *
   * For each day, we aggregate:
   * - UTM conversions (tag-tracked)
   * - Connector conversions (Stripe/Shopify)
   * - Platform spend
   *
   * We use the MAXIMUM of UTM vs Connector conversions to avoid
   * double-counting while ensuring we capture all conversions.
   */
  private buildDailyTimeSeries(
    dailyUtm: DailyUtmPerformance[],
    dailyConnector: DailyConnectorRevenue[],
    dailyPlatform: DailyPlatformMetrics[],
    startDate: string,
    endDate: string
  ): SmartAttributionTimeSeriesEntry[] {
    // Create a map of all dates in range
    const dateMap = new Map<string, {
      utmConversions: number;
      utmRevenue: number;
      connectorConversions: number;
      connectorRevenue: number;
      platformSpend: number;
      platformConversions: number;
      channelData: Map<string, { conversions: number; revenue: number; spend: number }>;
    }>();

    // Initialize all dates in range
    const start = new Date(startDate);
    const end = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      dateMap.set(dateStr, {
        utmConversions: 0,
        utmRevenue: 0,
        connectorConversions: 0,
        connectorRevenue: 0,
        platformSpend: 0,
        platformConversions: 0,
        channelData: new Map(),
      });
    }

    // Aggregate UTM data by date
    for (const utm of dailyUtm) {
      const day = dateMap.get(utm.date);
      if (day) {
        day.utmConversions += utm.conversions;
        day.utmRevenue += utm.revenue;

        // Track by channel (normalize source to channel name)
        const sourceLower = utm.utmSource.toLowerCase().trim();
        const isDirect = sourceLower === '(direct)' || sourceLower === 'direct' || sourceLower === '';
        const matchedPlatform = isDirect ? null : UTM_SOURCE_PLATFORMS[sourceLower];
        const channelKey = isDirect ? 'direct' : (matchedPlatform || sourceLower);

        const existing = day.channelData.get(channelKey) || { conversions: 0, revenue: 0, spend: 0 };
        existing.conversions += utm.conversions;
        existing.revenue += utm.revenue;
        day.channelData.set(channelKey, existing);
      }
    }

    // Aggregate connector data by date
    for (const conn of dailyConnector) {
      const day = dateMap.get(conn.date);
      if (day) {
        day.connectorConversions += conn.conversions;
        day.connectorRevenue += conn.revenue;
      }
    }

    // Aggregate platform data by date
    for (const plat of dailyPlatform) {
      const day = dateMap.get(plat.date);
      if (day) {
        day.platformSpend += plat.spend;
        day.platformConversions += plat.conversions;

        // Add platform spend to channel data
        const existing = day.channelData.get(plat.platform) || { conversions: 0, revenue: 0, spend: 0 };
        existing.spend += plat.spend;
        // If no UTM conversions for this platform, use platform-reported
        if (existing.conversions === 0) {
          existing.conversions = plat.conversions;
          existing.revenue = plat.revenue;
        }
        day.channelData.set(plat.platform, existing);
      }
    }

    // Build final time series
    const timeSeries: SmartAttributionTimeSeriesEntry[] = [];

    for (const [date, data] of dateMap) {
      // Use the maximum of UTM vs Connector conversions
      // This captures all conversions without double-counting
      const totalConversions = Math.max(data.utmConversions, data.connectorConversions);

      // Prefer connector revenue (actual transaction data) over UTM-tracked revenue
      const totalRevenue = data.connectorRevenue > 0 ? data.connectorRevenue : data.utmRevenue;

      // Convert channel map to array
      const channels = Array.from(data.channelData.entries()).map(([channel, metrics]) => ({
        channel,
        conversions: metrics.conversions,
        revenue: metrics.revenue,
        spend: metrics.spend,
      }));

      timeSeries.push({
        date,
        totalConversions,
        totalRevenue,
        totalSpend: data.platformSpend,
        channels,
      });
    }

    // Sort by date
    timeSeries.sort((a, b) => a.date.localeCompare(b.date));

    return timeSeries;
  }

  /**
   * Assess overall data quality
   */
  private assessDataQuality(
    platformMetrics: PlatformMetrics[],
    utmPerformance: UtmPerformance[],
    connectorRevenue: ConnectorRevenue[],
    hasTag: boolean,
    clickIdStats: { hasClickIds: boolean; clickIdCount: number; byType: Record<string, number> }
  ): {
    hasPlatformData: boolean;
    hasTagData: boolean;
    hasClickIds: boolean;
    hasConnectorData: boolean;
    clickIdCount: number;
    clickIdsByType: Record<string, number>;
    recommendations: string[];
  } {
    const recommendations: string[] = [];

    const hasPlatformData = platformMetrics.length > 0;
    const hasTagData = utmPerformance.length > 0;
    const hasClickIds = clickIdStats.hasClickIds;
    const hasConnectorData = connectorRevenue.length > 0;

    // Generate recommendations
    if (!hasTag) {
      recommendations.push('Install tracking tag to capture UTM parameters and session data');
    }

    if (!hasTagData && hasTag) {
      recommendations.push('No UTM data detected. Ensure your ad campaigns include UTM parameters.');
    }

    if (!hasConnectorData) {
      recommendations.push('Connect Stripe or Shopify to get ground-truth conversion data');
    }

    if (hasPlatformData && !hasTagData) {
      recommendations.push('Ad platforms connected but no UTM tracking. Add UTM parameters to verify attribution.');
    }

    const platformsWithSpend = platformMetrics.filter(p => p.spend > 0);
    const platformsWithConversions = platformMetrics.filter(p => p.conversions > 0);
    if (platformsWithSpend.length > 0 && platformsWithConversions.length === 0) {
      recommendations.push('Ad platforms have spend but no conversions. Verify conversion tracking is configured.');
    }

    // Add recommendation for click IDs if not present
    if (!hasClickIds && hasPlatformData) {
      recommendations.push('Enable auto-tagging in your ad platforms (Google/Meta/TikTok) to capture click IDs for 100% accurate attribution.');
    }

    return {
      hasPlatformData,
      hasTagData,
      hasClickIds,
      hasConnectorData,
      clickIdCount: clickIdStats.clickIdCount,
      clickIdsByType: clickIdStats.byType,
      recommendations
    };
  }
}
