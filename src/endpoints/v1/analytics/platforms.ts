import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { D1AnalyticsService } from "../../../services/d1-analytics";
import { getDBSession } from "../../../utils/db-session";
import { structuredLog } from "../../../utils/structured-logger";

/**
 * DEPRECATED: GetPlatformData class removed - broken table naming
 * Use platform-specific endpoints instead:
 * - /v1/analytics/facebook/* for Facebook Ads
 * - /v1/analytics/google/* for Google Ads
 * - /v1/analytics/tiktok/* for TikTok Ads
 */

/**
 * GET /v1/analytics/platforms/unified - Get unified cross-platform data
 */
export class GetUnifiedPlatformData extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get unified cross-platform data",
    description: "Fetches and merges data from multiple advertising platforms",
    operationId: "get-unified-platform-data",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Unified platform data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                summary: z.object({
                  total_spend_cents: z.number(),
                  total_impressions: z.number(),
                  total_clicks: z.number(),
                  total_conversions: z.number(),
                  total_conversion_value_cents: z.number(),
                  average_ctr: z.number(),
                  average_cpc_cents: z.number(),
                  platforms_active: z.array(z.string())
                }),
                by_platform: z.record(z.string(), z.object({
                  spend_cents: z.number(),
                  impressions: z.number(),
                  clicks: z.number(),
                  conversions: z.number(),
                  conversion_value_cents: z.number(),
                  campaigns: z.number()
                }))
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const startDate = c.req.query("start_date");
    const endDate = c.req.query("end_date");

    // Check if org has any active platform connections
    const session = getDBSession(c.env.DB);
    const activeConnections = await session.prepare(`
      SELECT DISTINCT platform FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).all();

    const AD_PLATFORMS = ['google', 'facebook', 'meta', 'tiktok', 'google_ads', 'meta_ads', 'tiktok_ads'];
    const allConnectedPlatforms = (activeConnections.results?.map(r => (r as { platform: string }).platform) || []) as string[];
    const activePlatforms = allConnectedPlatforms.filter(p => AD_PLATFORMS.includes(p));

    // If no active connections, return empty data
    if (activePlatforms.length === 0) {
      return success(c, {
        summary: {
          total_spend_cents: 0,
          total_impressions: 0,
          total_clicks: 0,
          total_conversions: 0,
          total_conversion_value_cents: 0,
          average_ctr: 0,
          average_cpc_cents: 0,
          platforms_active: [],
          platforms_connected: []
        },
        by_platform: {},
        time_series: []
      });
    }

    // Build effective date range (default: last 30 days)
    const effectiveDateRange = startDate && endDate
      ? { start: startDate, end: endDate }
      : {
          start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          end: new Date().toISOString().split('T')[0]
        };

    console.log(`[Unified] Fetching data for org ${orgId}, date range: ${effectiveDateRange.start} to ${effectiveDateRange.end}, platforms: ${JSON.stringify(activePlatforms)}`);

    try {
      const analyticsDb = c.env.ANALYTICS_DB;
      const d1Analytics = new D1AnalyticsService(analyticsDb);
      const { summary: d1Summary, by_platform } = await d1Analytics.getUnifiedPlatformSummary(
        orgId,
        effectiveDateRange.start,
        effectiveDateRange.end,
        activePlatforms
      );

      console.log(`[Unified] D1 Summary: spend=${d1Summary.spend_cents}, impressions=${d1Summary.impressions}, campaigns=${d1Summary.campaigns}`);
      console.log(`[Unified] By platform: ${JSON.stringify(by_platform)}`);

      const summary = {
        total_spend_cents: d1Summary.spend_cents,
        total_impressions: d1Summary.impressions,
        total_clicks: d1Summary.clicks,
        total_conversions: d1Summary.conversions,
        total_conversion_value_cents: d1Summary.conversion_value_cents,
        average_ctr: d1Summary.impressions > 0
          ? (d1Summary.clicks / d1Summary.impressions) * 100
          : 0,
        average_cpc_cents: d1Summary.clicks > 0
          ? Math.round(d1Summary.spend_cents / d1Summary.clicks)
          : 0,
        platforms_active: Object.keys(by_platform).filter(p => by_platform[p].campaigns > 0)
      };

      // Get conversion source setting
      const conversionSettings = await session.prepare(`
        SELECT conversion_source FROM ai_optimization_settings WHERE org_id = ?
      `).bind(orgId).first<{ conversion_source: string }>();
      const conversionSource = conversionSettings?.conversion_source || 'tag';

      let totalConversions = summary.total_conversions;

      // If using connectors for conversions, fetch from D1 connector_events
      if (conversionSource === 'connectors') {
        const stripeConversions = await this.fetchConnectorConversionsD1(
          c.env.ANALYTICS_DB,
          orgId,
          effectiveDateRange.start,
          effectiveDateRange.end
        );

        if (stripeConversions) {
          totalConversions = stripeConversions.total_conversions;
        }
      }

      // Fetch time series from D1
      const timeSeries = await this.fetchPlatformTimeSeriesD1(
        analyticsDb,
        orgId,
        activePlatforms,
        effectiveDateRange
      );

      console.log(`[Unified] Time series returned ${timeSeries.length} days of data`);
      if (timeSeries.length > 0) {
        console.log(`[Unified] First day: ${JSON.stringify(timeSeries[0])}`);
      }

      return success(c, {
        summary: {
          total_spend_cents: summary.total_spend_cents,
          total_impressions: summary.total_impressions,
          total_clicks: summary.total_clicks,
          total_conversions: totalConversions,
          total_conversion_value_cents: summary.total_conversion_value_cents,
          average_ctr: Math.round(summary.average_ctr * 100) / 100,
          average_cpc_cents: summary.average_cpc_cents,
          platforms_active: summary.platforms_active,
          platforms_connected: activePlatforms
        },
        by_platform,
        time_series: timeSeries
      });
    } catch (err) {
      structuredLog('ERROR', 'Unified data fetch error', { endpoint: 'platforms', error: err instanceof Error ? err.message : String(err) });
      return error(c, "QUERY_FAILED", "Failed to fetch unified data", 500);
    }
  }

  /**
   * Fetch conversions from D1 connector_events table.
   */
  private async fetchConnectorConversionsD1(
    db: any,
    orgId: string,
    startDate: string,
    endDate: string
  ): Promise<{ total_conversions: number; by_date: any[] } | null> {
    try {
      const result = await db.prepare(`
        SELECT
          DATE(transacted_at) as date,
          COUNT(*) as conversions
        FROM connector_events
        WHERE organization_id = ?
        AND source_platform = 'stripe'
        AND platform_status IN ('succeeded', 'paid', 'active')
        AND DATE(transacted_at) >= ?
        AND DATE(transacted_at) <= ?
        GROUP BY DATE(transacted_at)
        ORDER BY date ASC
      `).bind(orgId, startDate, endDate).all();

      const byDate = result.results || [];
      const totalConversions = byDate.reduce((sum: number, row: any) => sum + row.conversions, 0);

      return {
        total_conversions: totalConversions,
        by_date: byDate
      };
    } catch (err) {
      structuredLog('ERROR', 'Failed to fetch connector conversions from D1', { endpoint: 'platforms', step: 'stripe_conversions', error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Fetch daily time series data from D1
   * OPTIMIZED: Uses single UNION ALL query instead of N separate queries
   */
  private async fetchPlatformTimeSeriesD1(
    db: any,
    orgId: string,
    platforms: string[],
    dateRange: { start: string; end: string }
  ): Promise<Array<{
    date: string;
    total_spend_cents: number;
    total_impressions: number;
    total_clicks: number;
    total_conversions: number;
    by_platform: Record<string, { spend_cents: number; impressions: number; clicks: number; conversions: number }>;
  }>> {
    console.log(`[TimeSeries] Starting D1 aggregation for platforms: ${JSON.stringify(platforms)}`);

    // Build UNION ALL query for all requested platforms
    const unionParts: string[] = [];
    const params: unknown[] = [];

    // Normalize platforms
    const normalizedPlatforms = platforms.map(p => p.toLowerCase().replace('_ads', ''));
    const uniquePlatforms = [...new Set(normalizedPlatforms.map(p => p === 'meta' ? 'facebook' : p))];

    // Use unified ad_metrics table for all platforms
    for (const platform of uniquePlatforms) {
      if (!['google', 'facebook', 'tiktok'].includes(platform)) continue;

      unionParts.push(`
        SELECT
          '${platform}' as platform,
          metric_date as date,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          SUM(spend_cents) as spend_cents,
          SUM(conversions) as conversions
        FROM ad_metrics
        WHERE organization_id = ?
          AND platform = '${platform}'
          AND entity_type = 'campaign'
          AND metric_date >= ? AND metric_date <= ?
        GROUP BY metric_date
      `);
      params.push(orgId, dateRange.start, dateRange.end);
    }

    if (unionParts.length === 0) {
      console.log(`[TimeSeries] No valid platforms to query`);
      return [];
    }

    // Execute single UNION ALL query
    const query = unionParts.join(' UNION ALL ') + ' ORDER BY date ASC';

    try {
      const result = await db.prepare(query).bind(...params).all();

      console.log(`[TimeSeries] UNION ALL returned ${result.results?.length || 0} rows`);

      // Process results into daily aggregates
      const dailyData: Map<string, {
        date: string;
        total_spend_cents: number;
        total_impressions: number;
        total_clicks: number;
        total_conversions: number;
        by_platform: Record<string, { spend_cents: number; impressions: number; clicks: number; conversions: number }>;
      }> = new Map();

      for (const row of result.results || []) {
        const date = row.date;
        if (!date) continue;

        if (!dailyData.has(date)) {
          dailyData.set(date, {
            date,
            total_spend_cents: 0,
            total_impressions: 0,
            total_clicks: 0,
            total_conversions: 0,
            by_platform: {}
          });
        }

        const dayData = dailyData.get(date)!;
        const spend = row.spend_cents || 0;
        const impressions = row.impressions || 0;
        const clicks = row.clicks || 0;
        const conversions = row.conversions || 0;

        // Add to totals
        dayData.total_spend_cents += spend;
        dayData.total_impressions += impressions;
        dayData.total_clicks += clicks;
        dayData.total_conversions += conversions;

        // Add to platform breakdown
        if (!dayData.by_platform[row.platform]) {
          dayData.by_platform[row.platform] = { spend_cents: 0, impressions: 0, clicks: 0, conversions: 0 };
        }
        dayData.by_platform[row.platform].spend_cents += spend;
        dayData.by_platform[row.platform].impressions += impressions;
        dayData.by_platform[row.platform].clicks += clicks;
        dayData.by_platform[row.platform].conversions += conversions;
      }

      console.log(`[TimeSeries] Final dailyData has ${dailyData.size} dates`);
      return Array.from(dailyData.values()).sort((a, b) => a.date.localeCompare(b.date));
    } catch (err) {
      structuredLog('ERROR', 'Time series UNION ALL query failed', { endpoint: 'platforms', step: 'timeseries', error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }
}
