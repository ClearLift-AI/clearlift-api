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

    // Fetch all data sources in parallel
    const [
      platformMetrics,
      utmPerformance,
      connectorRevenue,
    ] = await Promise.all([
      this.getPlatformMetrics(orgId, startDate, endDate),
      orgTag ? this.getUtmPerformance(orgTag, startDate, endDate) : Promise.resolve([]),
      this.getConnectorRevenue(orgId, startDate, endDate),
    ]);

    console.log(`[SmartAttribution] Data sources: platforms=${platformMetrics.length}, utm=${utmPerformance.length}, connectors=${connectorRevenue.length}`);

    // Build attribution using signal hierarchy
    const attributions = this.buildAttributions(
      platformMetrics,
      utmPerformance,
      connectorRevenue
    );

    // Calculate summary
    const summary = this.calculateSummary(attributions);

    // Assess data quality
    const dataQuality = this.assessDataQuality(
      platformMetrics,
      utmPerformance,
      connectorRevenue,
      !!orgTag
    );

    return { attributions, summary, dataQuality };
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
   */
  private async getUtmPerformance(
    orgTag: string,
    startDate: string,
    endDate: string
  ): Promise<UtmPerformance[]> {
    try {
      const result = await this.analyticsDb.prepare(`
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

      return (result.results || []).map(r => ({
        utmSource: r.utm_source,
        utmMedium: r.utm_medium,
        utmCampaign: r.utm_campaign,
        sessions: r.sessions || 0,
        conversions: r.conversions || 0,
        revenue: r.revenue || 0
      }));
    } catch (err) {
      console.warn('[SmartAttribution] Failed to query UTM performance:', err);
      return [];
    }
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

    // Query Stripe
    try {
      const stripeResult = await this.analyticsDb.prepare(`
        SELECT
          COUNT(*) as conversions,
          COALESCE(SUM(amount_cents), 0) / 100.0 as revenue
        FROM stripe_charges
        WHERE organization_id = ?
          AND DATE(stripe_created_at) >= ?
          AND DATE(stripe_created_at) <= ?
          AND status = 'succeeded'
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
   * Build attributions using signal hierarchy
   *
   * Key insight: When we have connector revenue (Stripe/Shopify) but no direct
   * click-level attribution, we probabilistically distribute the revenue based
   * on session share. This gives us actionable attribution even without click IDs.
   */
  private buildAttributions(
    platformMetrics: PlatformMetrics[],
    utmPerformance: UtmPerformance[],
    connectorRevenue: ConnectorRevenue[]
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
      const matchedPlatform = UTM_SOURCE_PLATFORMS[sourceLower];
      const channelKey = matchedPlatform || sourceLower;

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
          channel: matchedPlatform || utm.utmSource,
          platform: matchedPlatform || null,
          medium: utm.utmMedium,
          campaign: utm.utmCampaign,
          sessions: utm.sessions,
          conversions: utm.conversions,
          revenue: utm.revenue,
          sources: [utm.utmSource]
        });
      }
    }

    console.log(`[SmartAttribution] Total UTM sessions: ${totalUtmSessions}, channels: ${aggregatedUtm.size}`);

    // Track which platforms have been processed via UTM
    const processedPlatforms = new Set<string>();

    // Probabilistic distribution: When we have connector revenue but UTM data
    // doesn't have conversions, distribute based on session share
    const useSessionBasedDistribution = hasConnectorData && totalUtmSessions > 0;

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
      const sessionShare = totalUtmSessions > 0 ? utm.sessions / totalUtmSessions : 0;

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

      // If UTM has direct conversions, use those
      if (utm.conversions > 0) {
        conversions = utm.conversions;
        revenue = utm.revenue;

        if (matchedPlatform && hasActiveSpend) {
          signalType = 'utm_with_spend';
          confidence = 95;
          dataQuality = 'corroborated';
          explanation = `${conversions} tracked conversion(s). UTM "${sourcesList}" matches ${matchedPlatform} with $${platformSpend.toFixed(0)} spend.`;
        } else if (matchedPlatform) {
          signalType = 'utm_no_spend';
          confidence = 90;
          dataQuality = 'single_source';
          explanation = `${conversions} tracked conversion(s). UTM "${sourcesList}" matches ${matchedPlatform}, no active spend.`;
        } else {
          signalType = 'utm_only';
          confidence = 85;
          dataQuality = 'single_source';
          explanation = `${conversions} tracked conversion(s) from "${sourcesList}".`;
        }
      }
      // Otherwise, probabilistically distribute connector revenue based on session share
      else if (useSessionBasedDistribution && sessionShare > 0) {
        conversions = Math.round(totalConnectorConversions * sessionShare * 100) / 100;
        revenue = Math.round(totalConnectorRevenue * sessionShare * 100) / 100;

        if (matchedPlatform && hasActiveSpend) {
          signalType = 'utm_with_spend';
          confidence = 75; // Lower confidence for probabilistic
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${(sessionShare * 100).toFixed(1)}% of sessions). UTM "${sourcesList}" + ${matchedPlatform} spend corroborates.`;
        } else if (matchedPlatform) {
          signalType = 'utm_no_spend';
          confidence = 70;
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${(sessionShare * 100).toFixed(1)}% of sessions). UTM "${sourcesList}" matches ${matchedPlatform}.`;
        } else {
          signalType = 'utm_only';
          confidence = 65;
          dataQuality = 'estimated';
          explanation = `Est. ${conversions.toFixed(1)} conv. (${(sessionShare * 100).toFixed(1)}% of sessions) from "${sourcesList}".`;
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
   * Assess overall data quality
   */
  private assessDataQuality(
    platformMetrics: PlatformMetrics[],
    utmPerformance: UtmPerformance[],
    connectorRevenue: ConnectorRevenue[],
    hasTag: boolean
  ): {
    hasPlatformData: boolean;
    hasTagData: boolean;
    hasClickIds: boolean;
    hasConnectorData: boolean;
    recommendations: string[];
  } {
    const recommendations: string[] = [];

    const hasPlatformData = platformMetrics.length > 0;
    const hasTagData = utmPerformance.length > 0;
    const hasClickIds = false; // Not yet implemented
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

    return {
      hasPlatformData,
      hasTagData,
      hasClickIds,
      hasConnectorData,
      recommendations
    };
  }
}
