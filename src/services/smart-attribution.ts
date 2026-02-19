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

import { CacheService } from './cache';
import { structuredLog } from '../utils/structured-logger';

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
  is_estimated: boolean;        // True when using probabilistic distribution, false for click ID matches
  estimation_reason: string | null;  // Explanation when is_estimated=true
}

/**
 * Calculate confidence score adjusted for sample size
 *
 * Base confidence comes from the signal type (click ID = 100, UTM = 85-95, etc.)
 * This is then adjusted based on the number of observations:
 * - 100+ samples: Full confidence (factor = 1.0)
 * - 10 samples: Reduced confidence (factor = 0.8)
 * - 1 sample: Minimum confidence (factor = 0.5)
 *
 * Formula: finalConfidence = baseConfidence × sampleSizeFactor
 * where sampleSizeFactor = min(1, 0.5 + 0.5 × (log10(sampleSize + 1) / 2))
 */
function calculateConfidence(baseConfidence: number, sampleSize: number): number {
  if (sampleSize <= 0) return Math.round(baseConfidence * 0.5);

  // Sample size factor: 100+ = 1.0, 10 = 0.8, 1 = 0.5
  const factor = Math.min(1, 0.5 + 0.5 * (Math.log10(sampleSize + 1) / 2));
  return Math.round(baseConfidence * factor);
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
  flowTag: string | null;
  isExclusive: boolean;
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
 * Supports optional KV caching for improved performance.
 */
export class SmartAttributionService {
  private analyticsDb: D1Database;
  private mainDb: D1Database;
  private cache: CacheService | null;

  constructor(analyticsDb: D1Database, mainDb: D1Database, kv?: KVNamespace) {
    this.analyticsDb = analyticsDb;
    this.mainDb = mainDb;
    this.cache = kv ? new CacheService(kv) : null;
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
      hasTimeDecayData: boolean;
      recommendations: string[];
    };
  }> {
    console.log(`[SmartAttribution] Starting for org=${orgId}, ${startDate} to ${endDate}`);

    // Check cache first
    if (this.cache) {
      const cacheKey = CacheService.smartAttributionKey(orgId, startDate, endDate);
      const cached = await this.cache.get<{
        attributions: SmartAttribution[];
        summary: { totalConversions: number; totalRevenue: number; dataCompleteness: number; signalBreakdown: Record<SignalType, { count: number; percentage: number }> };
        timeSeries: SmartAttributionTimeSeriesEntry[];
        dataQuality: { hasPlatformData: boolean; hasTagData: boolean; hasClickIds: boolean; hasConnectorData: boolean; hasTimeDecayData: boolean; recommendations: string[] };
      }>(cacheKey);

      if (cached) {
        console.log(`[SmartAttribution] Cache hit for ${cacheKey}`);
        return cached;
      }
    }

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
      clickLevelAttribution,
      funnelData,
    ] = await Promise.all([
      this.getPlatformMetrics(orgId, startDate, endDate),
      orgTag ? this.getUtmPerformance(orgTag, startDate, endDate) : Promise.resolve([]),
      this.getConnectorRevenue(orgId, startDate, endDate),
      orgTag ? this.getDailyUtmPerformance(orgTag, startDate, endDate) : Promise.resolve([]),
      this.getDailyConnectorRevenue(orgId, startDate, endDate),
      this.getDailyPlatformMetrics(orgId, startDate, endDate),
      this.getClickIdStats(orgId, startDate, endDate),
      this.getClickLevelAttribution(orgId, startDate, endDate),
      orgTag ? this.getFunnelPositionData(orgId, orgTag, startDate, endDate) : Promise.resolve([]),
    ]);

    console.log(`[SmartAttribution] Data sources: platforms=${platformMetrics.length}, utm=${utmPerformance.length}, connectors=${connectorRevenue.length}, clickLevel=${clickLevelAttribution.length}, funnelSteps=${funnelData.length}`);

    // Build attribution using signal hierarchy with funnel weighting
    const attributions = this.buildAttributions(
      platformMetrics,
      utmPerformance,
      connectorRevenue,
      funnelData,
      clickLevelAttribution,
      dailyUtmPerformance,
      dailyConnectorRevenue
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
      clickIdStats,
      dailyConnectorRevenue.length >= 2 && dailyUtmPerformance.length > 0
    );

    const result = { attributions, summary, timeSeries, dataQuality };

    // Cache the result for 5 minutes
    if (this.cache) {
      const cacheKey = CacheService.smartAttributionKey(orgId, startDate, endDate);
      this.cache.set(cacheKey, result, 300).catch(err => {
        structuredLog('ERROR', 'Failed to cache result', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
      });
      console.log(`[SmartAttribution] Cached result to ${cacheKey}`);
    }

    return result;
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
      structuredLog('WARN', 'Failed to get org tag', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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

    // Query all ad platforms from unified tables in a single query
    try {
      const platformResults = await this.analyticsDb.prepare(`
        SELECT
          c.platform,
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.impressions), 0) as impressions,
          COALESCE(SUM(m.clicks), 0) as clicks,
          COALESCE(SUM(m.conversions), 0) as conversions,
          COALESCE(SUM(m.conversion_value_cents), 0) / 100.0 as revenue
        FROM ad_campaigns c
        LEFT JOIN ad_metrics m
          ON c.id = m.entity_ref
          AND m.entity_type = 'campaign'
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        WHERE c.organization_id = ?
        GROUP BY c.platform
      `).bind(startDate, endDate, orgId).all<{
        platform: string;
        spend: number;
        impressions: number;
        clicks: number;
        conversions: number;
        revenue: number;
      }>();

      for (const row of platformResults.results) {
        if (row.spend > 0 || row.conversions > 0) {
          results.push({
            platform: row.platform,
            spend: row.spend || 0,
            impressions: row.impressions || 0,
            clicks: row.clicks || 0,
            conversions: row.conversions || 0,
            revenue: row.revenue || 0,
          });
        }
      }
    } catch (err) {
      structuredLog('WARN', 'Failed to query platform metrics from unified tables', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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
      structuredLog('WARN', 'Failed to query UTM performance', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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
      structuredLog('WARN', 'Failed to query direct traffic', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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

    // Query connector_events for all revenue platforms (stripe, shopify, jobber, etc.)
    try {
      const connectorResult = await this.analyticsDb.prepare(`
        SELECT
          source_platform,
          COUNT(*) as conversions,
          COALESCE(SUM(value_cents), 0) / 100.0 as revenue
        FROM connector_events
        WHERE organization_id = ?
          AND DATE(transacted_at) >= ?
          AND DATE(transacted_at) <= ?
          AND platform_status IN ('succeeded', 'paid', 'completed', 'active')
        GROUP BY source_platform
      `).bind(orgId, startDate, endDate).all<{
        source_platform: string;
        conversions: number;
        revenue: number;
      }>();

      for (const row of connectorResult.results || []) {
        if (row.conversions > 0) {
          results.push({
            source: row.source_platform,
            conversions: row.conversions,
            revenue: row.revenue || 0,
          });
        }
      }
    } catch (err) {
      structuredLog('WARN', 'Failed to query connector revenue', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
    }

    return results;
  }

  /**
   * Get funnel position data for weighting attribution.
   *
   * Returns connector-based funnel data from platform_connections with
   * conversion_events configured, plus ad platform click counts.
   */
  private async getFunnelPositionData(
    orgId: string,
    orgTag: string,
    startDate: string,
    endDate: string
  ): Promise<FunnelPositionData[]> {
    try {
      // Get connectors with conversion events configured
      const connectionsResult = await this.mainDb.prepare(`
        SELECT id, provider, platform, display_name, settings
        FROM platform_connections
        WHERE organization_id = ? AND status = 'active'
          AND json_extract(settings, '$.conversion_events') IS NOT NULL
      `).bind(orgId).all<{
        id: string;
        provider: string;
        platform: string;
        display_name: string | null;
        settings: string | null;
      }>();

      const connections = connectionsResult.results || [];
      if (connections.length === 0) {
        return [];
      }

      // Get channel distribution from daily_metrics
      const channelResult = await this.analyticsDb.prepare(`
        SELECT by_channel FROM daily_metrics
        WHERE org_tag = ? AND date >= ? AND date <= ?
      `).bind(orgTag, startDate.split('T')[0], endDate.split('T')[0]).all<{ by_channel: string | null }>();

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
          } catch (err) {
            structuredLog('WARN', 'Failed to parse by_channel JSON', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      const funnelData: FunnelPositionData[] = [];

      // Ad platforms are top-of-funnel (position 1), revenue connectors are bottom (position 2)
      for (const conn of connections) {
        const platform = conn.platform || conn.provider;
        let visitors = 0;

        try {
          if (['google', 'facebook', 'tiktok'].includes(platform)) {
            const result = await this.analyticsDb.prepare(`
              SELECT COALESCE(SUM(m.clicks), 0) as clicks
              FROM ad_campaigns c
              LEFT JOIN ad_metrics m
                ON c.id = m.entity_ref
                AND m.entity_type = 'campaign'
                AND m.metric_date >= ?
                AND m.metric_date <= ?
              WHERE c.organization_id = ? AND c.platform = ?
            `).bind(startDate, endDate, orgId, platform).first<{ clicks: number }>();
            visitors = result?.clicks || 0;
          } else {
            // Revenue connector — count events from connector_events
            const result = await this.analyticsDb.prepare(`
              SELECT COUNT(*) as conversions FROM connector_events
              WHERE organization_id = ? AND source_platform = ?
                AND DATE(transacted_at) >= ? AND DATE(transacted_at) <= ?
                AND platform_status IN ('succeeded', 'paid', 'completed', 'active')
            `).bind(orgId, platform, startDate, endDate).first<{ conversions: number }>();
            visitors = result?.conversions || 0;
          }
        } catch (err) {
          structuredLog('WARN', 'Failed to fetch visitors for connector', { service: 'smart-attribution', platform, error: err instanceof Error ? err.message : String(err) });
        }

        const byChannel: Record<string, number> = {};
        if (visitors > 0) {
          if (platform === 'google') {
            byChannel['paid_search'] = visitors;
          } else if (platform === 'facebook' || platform === 'tiktok') {
            byChannel['paid_social'] = visitors;
          } else if (totalChannelEvents > 0) {
            for (const [channel, eventCount] of Object.entries(channelDistribution)) {
              const ratio = eventCount / totalChannelEvents;
              const attributed = Math.round(visitors * ratio);
              if (attributed > 0) {
                byChannel[channel] = attributed;
              }
            }
          }
        }

        // Flat funnel: ad platforms = position 2, revenue connectors = position 1
        const isAdPlatform = ['google', 'facebook', 'tiktok'].includes(platform);
        const funnelPosition = isAdPlatform ? 1 : 2;

        funnelData.push({
          goalId: conn.id,
          goalName: conn.display_name || platform,
          funnelPosition,
          conversionRate: isAdPlatform ? 0.5 : 1.0,
          visitorCount: visitors,
          byChannel,
          flowTag: null,
          isExclusive: false,
        });
      }

      funnelData.sort((a, b) => b.funnelPosition - a.funnelPosition);
      return funnelData;
    } catch (err) {
      structuredLog('WARN', 'Failed to query funnel position data', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Get click-level attribution data from conversion_attribution table
   * This is pre-computed attribution data with click ID matches
   */
  private async getClickLevelAttribution(
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<{
    platform: string;
    clickIdType: string | null;
    model: string;
    revenue: number;
    conversions: number;
    creditPercent: number;
  }[]> {
    try {
      const result = await this.analyticsDb.prepare(`
        SELECT
          touchpoint_platform as platform,
          click_id_type,
          model,
          SUM(credit_value_cents) / 100.0 as revenue,
          COUNT(DISTINCT conversion_id) as conversions,
          AVG(credit_percent) as avg_credit_percent
        FROM conversion_attribution
        WHERE organization_id = ?
          AND touchpoint_timestamp >= ?
          AND touchpoint_timestamp <= ?
          AND click_id IS NOT NULL
        GROUP BY touchpoint_platform, click_id_type, model
      `).bind(orgId, startDate, endDate + 'T23:59:59Z').all();

      const rows = (result.results || []) as Array<{
        platform: string;
        click_id_type: string | null;
        model: string;
        revenue: number;
        conversions: number;
        avg_credit_percent: number;
      }>;

      return rows.map(row => ({
        platform: row.platform,
        clickIdType: row.click_id_type,
        model: row.model,
        revenue: row.revenue || 0,
        conversions: row.conversions || 0,
        creditPercent: row.avg_credit_percent || 0,
      }));
    } catch (err) {
      structuredLog('WARN', 'Failed to query click-level attribution', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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
      structuredLog('WARN', 'Failed to query click ID stats', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
      return { hasClickIds: false, clickIdCount: 0, byType: {} };
    }
  }

  /**
   * Compute daily time-decay distribution of connector revenue across channels.
   *
   * For each conversion day, looks back through past days of UTM session data
   * and weights each day's sessions with exponential decay. Channels with more
   * sessions on/near conversion days get proportionally more credit.
   *
   * Formula: weight = exp(-daysBack × ln(2) / halfLifeDays)
   * Default: 2-day half-life, 7-day lookback
   *
   * Uses the SAME utm_source channel names as utm_performance, avoiding the
   * channel classification mismatch that would occur with hourly_metrics.by_channel.
   *
   * Returns per-channel credit (sums match connector totals exactly).
   */
  private computeDailyTimeDecayDistribution(
    dailyUtm: DailyUtmPerformance[],
    dailyConnector: DailyConnectorRevenue[],
    aggregatedChannels: Map<string, { channel: string; platform: string | null; sessions: number; sources: string[] }>,
    remainingConversions: number,
    remainingRevenue: number,
    halfLifeDays: number = 2,
    lookbackDays: number = 7
  ): Map<string, { credit: number; revenue: number; matchedDays: number }> | null {
    // Aggregate daily connector conversions by date
    const convByDate = new Map<string, { conversions: number; revenue: number }>();
    for (const dc of dailyConnector) {
      const existing = convByDate.get(dc.date);
      if (existing) {
        existing.conversions += dc.conversions;
        existing.revenue += dc.revenue;
      } else {
        convByDate.set(dc.date, { conversions: dc.conversions, revenue: dc.revenue });
      }
    }

    if (convByDate.size < 2) return null; // Need at least 2 conversion days

    // Build daily sessions per channel: "channelKey|date" → sessions
    const channelDailyMap = new Map<string, number>();
    for (const utm of dailyUtm) {
      const sourceLower = (utm.utmSource || '').toLowerCase().trim();
      const isDirect = sourceLower === '(direct)' || sourceLower === 'direct' || sourceLower === '';
      const matchedPlatform = isDirect ? null : UTM_SOURCE_PLATFORMS[sourceLower];
      const channelKey = isDirect ? 'direct' : (matchedPlatform || sourceLower);

      const key = `${channelKey}|${utm.date}`;
      channelDailyMap.set(key, (channelDailyMap.get(key) || 0) + utm.sessions);
    }

    const ln2 = Math.LN2;
    const decayRate = ln2 / halfLifeDays;
    const channels = Array.from(aggregatedChannels.keys());

    const channelCredits = new Map<string, { credit: number; revenue: number; matchedDays: number }>();
    for (const ch of channels) {
      channelCredits.set(ch, { credit: 0, revenue: 0, matchedDays: 0 });
    }

    let totalDistributedConv = 0;
    let totalDistributedRev = 0;

    for (const [convDate, convData] of convByDate) {
      const convTime = new Date(convDate + 'T12:00:00Z').getTime();

      // Accumulate decay-weighted sessions per channel
      const weightedSessions = new Map<string, number>();
      let totalWeighted = 0;

      for (let daysBack = 0; daysBack <= lookbackDays; daysBack++) {
        const lookDate = new Date(convTime - daysBack * 86400_000);
        const dateStr = lookDate.toISOString().split('T')[0];
        const decayWeight = Math.exp(-daysBack * decayRate);

        for (const ch of channels) {
          const sessions = channelDailyMap.get(`${ch}|${dateStr}`) || 0;
          if (sessions > 0) {
            const weighted = sessions * decayWeight;
            weightedSessions.set(ch, (weightedSessions.get(ch) || 0) + weighted);
            totalWeighted += weighted;
          }
        }
      }

      if (totalWeighted > 0) {
        for (const [ch, w] of weightedSessions) {
          const share = w / totalWeighted;
          const entry = channelCredits.get(ch);
          if (entry) {
            entry.credit += convData.conversions * share;
            entry.revenue += convData.revenue * share;
            entry.matchedDays++;
          }
        }
        totalDistributedConv += convData.conversions;
        totalDistributedRev += convData.revenue;
      }
    }

    // Scale to match remaining connector totals (accounts for click-attributed deductions)
    if (totalDistributedConv > 0) {
      const convScale = remainingConversions / totalDistributedConv;
      const revScale = totalDistributedRev > 0 ? remainingRevenue / totalDistributedRev : 0;
      for (const entry of channelCredits.values()) {
        entry.credit = Math.round(entry.credit * convScale * 100) / 100;
        entry.revenue = Math.round(entry.revenue * revScale * 100) / 100;
      }
    }

    console.log(`[SmartAttribution] Time-decay distribution: ${convByDate.size} conversion days, ${channels.length} channels`);
    return channelCredits;
  }

  /**
   * Build attributions using signal hierarchy with funnel weighting
   *
   * Priority order:
   * 1. Click ID matches from conversion_attribution table (100% confidence, measured)
   * 2. UTM-tracked conversions
   * 3. Time-decay distribution based on daily session proximity to conversions
   * 4. Flat session-share distribution (fallback)
   *
   * Key insight: When we have connector revenue (Stripe/Shopify) but no direct
   * click-level attribution, we probabilistically distribute the revenue based
   * on session share. With daily connector data available, time-decay weighting
   * gives more credit to channels whose sessions occurred on/near conversion days.
   *
   * Time-Decay Formula (preferred when daily data available):
   *   weight = sessions × exp(-daysBack × ln(2) / 2)
   *   2-day half-life, 7-day lookback window
   *
   * Funnel Weight Formula (flat fallback):
   *   weight = sessionShare × (1 + funnelBonus)
   *   where funnelBonus = Σ(position × conversionRate) for all reached funnel steps
   */
  private buildAttributions(
    platformMetrics: PlatformMetrics[],
    utmPerformance: UtmPerformance[],
    connectorRevenue: ConnectorRevenue[],
    funnelData: FunnelPositionData[] = [],
    clickLevelAttribution: {
      platform: string;
      clickIdType: string | null;
      model: string;
      revenue: number;
      conversions: number;
      creditPercent: number;
    }[] = [],
    dailyUtm: DailyUtmPerformance[] = [],
    dailyConnector: DailyConnectorRevenue[] = []
  ): SmartAttribution[] {
    const attributions: SmartAttribution[] = [];

    // Calculate total connector revenue (ground truth for conversions)
    const totalConnectorConversions = connectorRevenue.reduce((sum, c) => sum + c.conversions, 0);
    const totalConnectorRevenue = connectorRevenue.reduce((sum, c) => sum + c.revenue, 0);
    const hasConnectorData = totalConnectorConversions > 0;

    console.log(`[SmartAttribution] Connector totals: ${totalConnectorConversions} conversions, $${totalConnectorRevenue}`);

    // PRIORITY 1: Process click-level attribution first (highest confidence)
    // These are conversions with verified click ID matches - ground truth
    const clickAttributedPlatforms = new Set<string>();
    let clickAttributedConversions = 0;
    let clickAttributedRevenue = 0;

    if (clickLevelAttribution.length > 0) {
      // Aggregate by platform (sum across models, preferring last_touch)
      const clickByPlatform = new Map<string, {
        revenue: number;
        conversions: number;
        clickIdTypes: Set<string>;
      }>();

      for (const click of clickLevelAttribution) {
        if (!click.platform) continue;

        const existing = clickByPlatform.get(click.platform);
        if (existing) {
          // Only add if this is last_touch model (avoid double counting)
          if (click.model === 'last_touch') {
            existing.revenue += click.revenue;
            existing.conversions += click.conversions;
          }
          if (click.clickIdType) {
            existing.clickIdTypes.add(click.clickIdType);
          }
        } else {
          clickByPlatform.set(click.platform, {
            revenue: click.model === 'last_touch' ? click.revenue : 0,
            conversions: click.model === 'last_touch' ? click.conversions : 0,
            clickIdTypes: new Set(click.clickIdType ? [click.clickIdType] : []),
          });
        }
      }

      for (const [platform, data] of clickByPlatform) {
        if (data.conversions > 0) {
          clickAttributedPlatforms.add(platform);
          clickAttributedConversions += data.conversions;
          clickAttributedRevenue += data.revenue;

          const clickTypes = Array.from(data.clickIdTypes).join(', ');
          const platformSpend = platformMetrics.find(p => p.platform === platform)?.spend || 0;

          attributions.push({
            channel: platform,
            platform: platform,
            medium: platform === 'google' ? 'cpc' : 'paid',
            campaign: null,
            conversions: data.conversions,
            revenue: data.revenue,
            confidence: 100,
            signalType: 'click_id',
            dataQuality: 'verified',
            signals: {
              platform: platform,
              hasClickIds: true,
              clickIdCount: data.conversions,
              hasUtmMatches: false,
              utmSessionCount: 0,
              hasActiveSpend: platformSpend > 0,
              spendAmount: platformSpend,
              hasPlatformReported: true,
              platformConversions: data.conversions,
              platformRevenue: data.revenue,
              hasTagData: true,
              tagConversions: data.conversions,
              tagRevenue: data.revenue
            },
            explanation: `${data.conversions} verified conversion(s) via ${clickTypes} click ID match. Ground truth attribution.`,
            is_estimated: false,
            estimation_reason: null
          });

          console.log(`[SmartAttribution] Click-level: ${platform} = ${data.conversions} conversions, $${data.revenue} (${clickTypes})`);
        }
      }
    }

    console.log(`[SmartAttribution] Click-attributed: ${clickAttributedConversions} conversions, $${clickAttributedRevenue}`);

    // Adjust connector totals to exclude click-attributed conversions
    const remainingConnectorConversions = Math.max(0, totalConnectorConversions - clickAttributedConversions);
    const remainingConnectorRevenue = Math.max(0, totalConnectorRevenue - clickAttributedRevenue);

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

    // Add click-attributed platforms to processed set (already handled above)
    for (const platform of clickAttributedPlatforms) {
      processedPlatforms.add(platform);
    }

    // Probabilistic distribution: When we have remaining connector revenue but UTM data
    // doesn't have conversions, distribute based on session share
    const useSessionBasedDistribution = remainingConnectorConversions > 0 && totalUtmSessions > 0;

    // Compute daily time-decay distribution when daily connector data is available
    // Uses same utm_source channel names — no classification mismatch
    let timeDecayCredits: Map<string, { credit: number; revenue: number; matchedDays: number }> | null = null;
    if (useSessionBasedDistribution && dailyConnector.length >= 2 && dailyUtm.length > 0) {
      timeDecayCredits = this.computeDailyTimeDecayDistribution(
        dailyUtm, dailyConnector, aggregatedUtm,
        remainingConnectorConversions, remainingConnectorRevenue
      );
    }

    // Build funnel bonus lookup by channel
    // Channels with visitors at higher funnel positions get bonus weighting
    const funnelBonusByChannel = new Map<string, { bonus: number; maxPosition: number; steps: string[]; flowTag: string | null }>();
    // Build exclusive flow channel sets for gating
    const exclusiveFlowChannels = new Map<string, Set<string>>(); // flow_tag → channels
    if (funnelData.length > 0) {
      for (const funnelStep of funnelData) {
        // Track exclusive flow channels
        if (funnelStep.flowTag && funnelStep.isExclusive) {
          if (!exclusiveFlowChannels.has(funnelStep.flowTag)) {
            exclusiveFlowChannels.set(funnelStep.flowTag, new Set());
          }
          for (const ch of Object.keys(funnelStep.byChannel)) {
            exclusiveFlowChannels.get(funnelStep.flowTag)!.add(ch.toLowerCase());
          }
        }

        for (const [channel, visitorCount] of Object.entries(funnelStep.byChannel)) {
          const normalizedChannel = channel.toLowerCase();
          const existing = funnelBonusByChannel.get(normalizedChannel) || { bonus: 0, maxPosition: 0, steps: [], flowTag: null };

          // Add bonus based on funnel position × conversion rate
          const stepBonus = funnelStep.funnelPosition * funnelStep.conversionRate;
          existing.bonus += stepBonus;
          existing.maxPosition = Math.max(existing.maxPosition, funnelStep.funnelPosition);
          if (!existing.steps.includes(funnelStep.goalName)) {
            existing.steps.push(funnelStep.goalName);
          }
          if (funnelStep.flowTag) {
            existing.flowTag = funnelStep.flowTag;
          }

          funnelBonusByChannel.set(normalizedChannel, existing);
        }
      }
      console.log(`[SmartAttribution] Funnel bonuses computed for ${funnelBonusByChannel.size} channels, ${exclusiveFlowChannels.size} exclusive flows`);
    }

    // Build set of all channels in any exclusive flow (for gating boost)
    const allExclusiveChannels = new Set<string>();
    for (const channels of exclusiveFlowChannels.values()) {
      for (const ch of channels) allExclusiveChannels.add(ch);
    }

    // Calculate total weighted sessions (for normalization)
    // Channels in exclusive flows get an additional boost since they represent
    // dedicated conversion paths that should concentrate credit
    let totalWeightedSessions = 0;
    const channelWeights = new Map<string, number>();
    for (const [channelKey, utm] of aggregatedUtm) {
      const bonus = funnelBonusByChannel.get(channelKey.toLowerCase())?.bonus || 0;
      const exclusiveBoost = allExclusiveChannels.has(channelKey.toLowerCase()) ? 1.5 : 1.0;
      const weight = utm.sessions * (1 + bonus) * exclusiveBoost;
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

      // Track estimation status
      let isEstimated = false;
      let estimationReason: string | null = null;

      // If UTM has direct conversions, use those
      if (utm.conversions > 0) {
        conversions = utm.conversions;
        revenue = utm.revenue;
        isEstimated = false; // Direct UTM-tracked conversions are measured, not estimated

        // Use sample size (conversions) to adjust confidence
        const sampleSize = utm.conversions;

        if (matchedPlatform && hasActiveSpend) {
          signalType = 'utm_with_spend';
          confidence = calculateConfidence(95, sampleSize);
          dataQuality = 'corroborated';
          explanation = `${conversions} tracked conversion(s). UTM "${sourcesList}" matches ${matchedPlatform} with $${platformSpend.toFixed(0)} spend.${funnelSuffix}`;
        } else if (matchedPlatform) {
          signalType = 'utm_no_spend';
          confidence = calculateConfidence(90, sampleSize);
          dataQuality = 'single_source';
          explanation = `${conversions} tracked conversion(s). UTM "${sourcesList}" matches ${matchedPlatform}, no active spend.${funnelSuffix}`;
        } else {
          signalType = 'utm_only';
          confidence = calculateConfidence(85, sampleSize);
          dataQuality = 'single_source';
          explanation = `${conversions} tracked conversion(s) from "${sourcesList}".${funnelSuffix}`;
        }
      }
      // Time-decay distribution: weight by daily session proximity to conversions
      else if (useSessionBasedDistribution && timeDecayCredits) {
        const decayEntry = timeDecayCredits.get(channelKey);
        if (decayEntry && decayEntry.credit > 0) {
          conversions = decayEntry.credit;
          revenue = decayEntry.revenue;
          isEstimated = true;
          estimationReason = `Distributed via time-decay weighting (2-day half-life) across ${decayEntry.matchedDays} conversion day(s) within 7-day lookback`;

          const decayShare = remainingConnectorConversions > 0
            ? (conversions / remainingConnectorConversions * 100).toFixed(1)
            : '0.0';

          const sampleSize = utm.sessions;

          if (matchedPlatform && hasActiveSpend) {
            signalType = 'utm_with_spend';
            confidence = calculateConfidence(82, sampleSize);
            dataQuality = 'estimated';
            explanation = `Est. ${conversions.toFixed(1)} conv. (${decayShare}% time-decay share). UTM "${sourcesList}" + ${matchedPlatform} spend corroborates.${funnelSuffix}`;
          } else if (matchedPlatform) {
            signalType = 'utm_no_spend';
            confidence = calculateConfidence(77, sampleSize);
            dataQuality = 'estimated';
            explanation = `Est. ${conversions.toFixed(1)} conv. (${decayShare}% time-decay share). UTM "${sourcesList}" matches ${matchedPlatform}.${funnelSuffix}`;
          } else {
            signalType = 'utm_only';
            confidence = calculateConfidence(72, sampleSize);
            dataQuality = 'estimated';
            explanation = `Est. ${conversions.toFixed(1)} conv. (${decayShare}% time-decay share) from "${sourcesList}".${funnelSuffix}`;
          }
        } else {
          // Channel had no sessions near conversion days
          conversions = 0;
          revenue = 0;
          signalType = 'utm_only';
          confidence = calculateConfidence(50, utm.sessions);
          dataQuality = 'estimated';
          isEstimated = true;
          estimationReason = 'No sessions within 7-day lookback of any conversion day';
          explanation = `${utm.sessions} sessions from "${sourcesList}", no temporal proximity to conversions.`;
        }
      }
      // Fallback: flat session-share distribution (no daily connector data for time-decay)
      else if (useSessionBasedDistribution && sessionShare > 0) {
        conversions = Math.round(remainingConnectorConversions * sessionShare * 100) / 100;
        revenue = Math.round(remainingConnectorRevenue * sessionShare * 100) / 100;
        isEstimated = true; // Probabilistic distribution is estimated
        estimationReason = funnelInfo && funnelInfo.bonus > 0
          ? `Distributed ${(sessionShare * 100).toFixed(1)}% of connector revenue using funnel-weighted session share (no click ID match available)`
          : `Distributed ${(sessionShare * 100).toFixed(1)}% of connector revenue by session proportion (no click ID match available)`;

        // Build share explanation - mention funnel weighting if applied
        const shareExplanation = funnelInfo && funnelInfo.bonus > 0
          ? `${(sessionShare * 100).toFixed(1)}% funnel-weighted share`
          : `${(sessionShare * 100).toFixed(1)}% of sessions`;

        // Use session count as sample size for estimated attributions
        const sampleSize = utm.sessions;
        const hasFunnelBonus = funnelInfo && funnelInfo.bonus > 0;

        if (matchedPlatform && hasActiveSpend) {
          signalType = 'utm_with_spend';
          confidence = calculateConfidence(hasFunnelBonus ? 80 : 75, sampleSize);
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${shareExplanation}). UTM "${sourcesList}" + ${matchedPlatform} spend corroborates.${funnelSuffix}`;
        } else if (matchedPlatform) {
          signalType = 'utm_no_spend';
          confidence = calculateConfidence(hasFunnelBonus ? 75 : 70, sampleSize);
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${shareExplanation}). UTM "${sourcesList}" matches ${matchedPlatform}.${funnelSuffix}`;
        } else {
          signalType = 'utm_only';
          confidence = calculateConfidence(hasFunnelBonus ? 70 : 65, sampleSize);
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${shareExplanation}) from "${sourcesList}".${funnelSuffix}`;
        }
      } else {
        // No conversions and no connector data to distribute
        conversions = 0;
        revenue = 0;
        signalType = 'utm_only';
        confidence = calculateConfidence(50, utm.sessions);
        dataQuality = 'estimated';
        isEstimated = true;
        estimationReason = 'No conversion data available - only session count known';
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
          explanation,
          is_estimated: isEstimated,
          estimation_reason: estimationReason
        });
      }
    }

    // Priority 5: Platform-only data (70% confidence)
    // Only add platforms that haven't been attributed via UTMs
    for (const pm of platformMetrics) {
      if (processedPlatforms.has(pm.platform)) continue;

      if (pm.conversions > 0 || pm.spend > 0) {
        // Use platform conversions as sample size
        const sampleSize = pm.conversions > 0 ? pm.conversions : pm.clicks;
        attributions.push({
          channel: pm.platform,
          platform: pm.platform,
          medium: pm.platform === 'google' ? 'cpc' : 'paid',
          campaign: null,
          conversions: pm.conversions,
          revenue: pm.revenue,
          confidence: calculateConfidence(70, sampleSize),
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
          explanation: `Platform self-reported ${pm.conversions} conversion(s) with $${pm.spend.toFixed(0)} spend. No tag verification.`,
          is_estimated: false, // Platform-reported data is not estimated
          estimation_reason: null
        });
      }
    }

    // Add unattributed/direct if there's leftover connector revenue
    const totalAttributedConversions = attributions.reduce((sum, a) => sum + a.conversions, 0);
    const totalAttributedRevenue = attributions.reduce((sum, a) => sum + a.revenue, 0);

    // Account for sessions without UTM (direct traffic)
    // If we have connector conversions but didn't distribute all of them
    // Use the original totals (not remaining) since attributions now include click-attributed
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
          explanation: `${unattributedConversions.toFixed(1)} conversion(s) without UTM tracking. Direct traffic or missing attribution.`,
          is_estimated: true,
          estimation_reason: 'Remainder after attributing to known channels - no UTM or click ID data available'
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
      structuredLog('WARN', 'Failed to query daily UTM performance', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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

    // Query all revenue connectors from connector_events by date
    try {
      const connectorResult = await this.analyticsDb.prepare(`
        SELECT
          DATE(transacted_at) as date,
          source_platform,
          COUNT(*) as conversions,
          COALESCE(SUM(value_cents), 0) / 100.0 as revenue
        FROM connector_events
        WHERE organization_id = ?
          AND DATE(transacted_at) >= ?
          AND DATE(transacted_at) <= ?
          AND platform_status IN ('succeeded', 'paid', 'completed', 'active')
        GROUP BY DATE(transacted_at), source_platform
        ORDER BY date
      `).bind(orgId, startDate, endDate).all<{
        date: string;
        source_platform: string;
        conversions: number;
        revenue: number;
      }>();

      for (const r of connectorResult.results || []) {
        results.push({
          date: r.date,
          source: r.source_platform,
          conversions: r.conversions,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      structuredLog('WARN', 'Failed to query daily connector revenue', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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

    // Query all platforms from unified tables in a single query
    try {
      const platformResults = await this.analyticsDb.prepare(`
        SELECT
          c.platform,
          m.metric_date as date,
          COALESCE(SUM(m.spend_cents), 0) / 100.0 as spend,
          COALESCE(SUM(m.conversions), 0) as conversions,
          COALESCE(SUM(m.conversion_value_cents), 0) / 100.0 as revenue
        FROM ad_campaigns c
        JOIN ad_metrics m
          ON c.id = m.entity_ref
          AND m.entity_type = 'campaign'
        WHERE c.organization_id = ?
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        GROUP BY c.platform, m.metric_date
        ORDER BY m.metric_date
      `).bind(orgId, startDate, endDate).all<{
        platform: string;
        date: string;
        spend: number;
        conversions: number;
        revenue: number;
      }>();

      for (const r of platformResults.results || []) {
        results.push({
          date: r.date,
          platform: r.platform,
          spend: r.spend || 0,
          conversions: r.conversions || 0,
          revenue: r.revenue || 0,
        });
      }
    } catch (err) {
      structuredLog('WARN', 'Failed to query daily platform metrics from unified tables', { service: 'smart-attribution', error: err instanceof Error ? err.message : String(err) });
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
    clickIdStats: { hasClickIds: boolean; clickIdCount: number; byType: Record<string, number> },
    hasTimeDecayData: boolean = false
  ): {
    hasPlatformData: boolean;
    hasTagData: boolean;
    hasClickIds: boolean;
    hasConnectorData: boolean;
    hasTimeDecayData: boolean;
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
      hasTimeDecayData,
      clickIdCount: clickIdStats.clickIdCount,
      clickIdsByType: clickIdStats.byType,
      recommendations
    };
  }
}
