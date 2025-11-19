import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

/**
 * Platform data schemas
 */
const PlatformDataSchema = z.object({
  campaigns: z.array(z.any()).optional(),
  ad_groups: z.array(z.any()).optional(),
  ads: z.array(z.any()).optional(),
  metrics: z.array(z.any()).optional()
});

/**
 * GET /v1/analytics/platforms/:platform - Get platform-specific data from Supabase
 */
export class GetPlatformData extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get platform-specific advertising data",
    description: "Fetches campaign, ad group, and ad data from Supabase for a specific platform",
    operationId: "get-platform-data",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        platform: z.enum(['google', 'facebook', 'tiktok']).describe("Advertising platform")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
        entity: z.enum(['campaigns', 'ad_groups', 'ads', 'all']).optional().describe("Entity type to fetch (default: all)")
      })
    },
    responses: {
      "200": {
        description: "Platform data from Supabase",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: PlatformDataSchema,
              meta: z.object({
                platform: z.string(),
                organization_id: z.string(),
                date_range: z.object({
                  start_date: z.string().optional(),
                  end_date: z.string().optional()
                })
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const session = c.get("session");
    const { platform } = c.req.param();
    const orgId = c.req.query("org_id");
    const startDate = c.req.query("start_date");
    const endDate = c.req.query("end_date");
    const entity = c.req.query("entity") || "all";

    if (!orgId) {
      return error(c, "MISSING_ORG_ID", "org_id query parameter is required", 400);
    }

    // Verify user has access to the organization
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Get Supabase secret key from Secrets Store
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: supabaseKey
    });

    try {
      const data: any = {};

      // Build date filter
      const dateFilter: string[] = [];
      if (startDate && endDate) {
        dateFilter.push(`date.gte.${startDate}`, `date.lte.${endDate}`);
      }

      // Fetch campaigns
      if (entity === 'campaigns' || entity === 'all') {
        const campaigns = await this.fetchTableData(
          supabase,
          `${platform}_ads_campaigns`,
          orgId,
          dateFilter
        );
        if (campaigns) data.campaigns = campaigns;
      }

      // Fetch ad groups (not available for all platforms)
      if ((entity === 'ad_groups' || entity === 'all') && platform !== 'tiktok') {
        const adGroups = await this.fetchTableData(
          supabase,
          `${platform}_ads_ad_groups`,
          orgId,
          dateFilter
        );
        if (adGroups) data.ad_groups = adGroups;
      }

      // Fetch ads
      if (entity === 'ads' || entity === 'all') {
        const ads = await this.fetchTableData(
          supabase,
          `${platform}_ads_${platform === 'google' ? 'ads' : 'creatives'}`,
          orgId,
          dateFilter
        );
        if (ads) data.ads = ads;
      }

      return success(c, data, {
        platform,
        organization_id: orgId,
        date_range: {
          start_date: startDate,
          end_date: endDate
        }
      });
    } catch (err) {
      console.error("Platform data fetch error:", err);
      return error(c, "SUPABASE_ERROR", "Failed to fetch platform data", 500);
    }
  }

  private async fetchTableData(
    supabase: SupabaseClient,
    tableName: string,
    orgId: string,
    dateFilter: string[]
  ): Promise<any[] | null> {
    try {
      // Build query string
      const filters = [`organization_id.eq.${orgId}`, ...dateFilter];
      const query = filters.join('&');

      const data = await supabase.select(
        tableName,
        query,
        { limit: 1000, order: 'created_at.desc' }
      );

      return data;
    } catch (err) {
      console.error(`Failed to fetch from ${tableName}:`, err);
      return null;
    }
  }
}

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
                  average_ctr: z.number(),
                  average_cpc_cents: z.number(),
                  platforms_active: z.array(z.string())
                }),
                by_platform: z.record(z.string(), z.object({
                  spend_cents: z.number(),
                  impressions: z.number(),
                  clicks: z.number(),
                  conversions: z.number(),
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
    const session = c.get("session");
    const orgId = c.req.query("org_id");
    const startDate = c.req.query("start_date");
    const endDate = c.req.query("end_date");

    if (!orgId) {
      return error(c, "MISSING_ORG_ID", "org_id query parameter is required", 400);
    }

    // Verify user has access to the organization
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, orgId);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Get conversion source setting
    const conversionSettings = await c.env.DB.prepare(`
      SELECT conversion_source FROM ai_optimization_settings WHERE org_id = ?
    `).bind(orgId).first();
    const conversionSource = conversionSettings?.conversion_source || 'tag';

    // Get active ad platform connections for this org (exclude non-ad platforms like Stripe)
    const connections = await c.env.DB.prepare(`
      SELECT platform FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
      AND platform IN ('google', 'facebook', 'tiktok')
    `).bind(orgId).all();

    if (!connections.results || connections.results.length === 0) {
      return success(c, {
        summary: {
          total_spend_cents: 0,
          total_impressions: 0,
          total_clicks: 0,
          average_ctr: 0,
          average_cpc_cents: 0,
          platforms_active: []
        },
        by_platform: {}
      });
    }

    // Get Supabase secret key from Secrets Store
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: supabaseKey
    });

    try {
      const byPlatform: Record<string, any> = {};
      const timeSeriesByDate: Record<string, any> = {};
      let totalSpendCents = 0;
      let totalImpressions = 0;
      let totalClicks = 0;
      let totalConversions = 0;

      // Fetch data for each connected platform
      for (const conn of connections.results) {
        const platform = conn.platform as string;

        // Fetch aggregated metrics
        const metrics = await this.fetchPlatformMetrics(
          supabase,
          platform,
          orgId,
          startDate,
          endDate
        );

        if (metrics) {
          byPlatform[platform] = metrics;
          totalSpendCents += metrics.spend_cents;
          totalImpressions += metrics.impressions;
          totalClicks += metrics.clicks;
          // Only add ad platform conversions if not using connectors
          if (conversionSource !== 'connectors') {
            totalConversions += metrics.conversions || 0;
          }
        }

        // Fetch daily time series data
        const timeSeries = await this.fetchPlatformTimeSeries(
          supabase,
          platform,
          orgId,
          startDate,
          endDate
        );

        // Merge time series data by date
        if (timeSeries) {
          for (const dayData of timeSeries) {
            if (!timeSeriesByDate[dayData.date]) {
              timeSeriesByDate[dayData.date] = {
                date: dayData.date,
                total_spend_cents: 0,
                total_impressions: 0,
                total_clicks: 0,
                total_conversions: 0,
                by_platform: {}
              };
            }

            timeSeriesByDate[dayData.date].total_spend_cents += dayData.spend_cents;
            timeSeriesByDate[dayData.date].total_impressions += dayData.impressions;
            timeSeriesByDate[dayData.date].total_clicks += dayData.clicks;
            // Only add ad platform conversions if not using connectors
            if (conversionSource !== 'connectors') {
              timeSeriesByDate[dayData.date].total_conversions += dayData.conversions;
            }
            timeSeriesByDate[dayData.date].by_platform[platform] = {
              spend_cents: dayData.spend_cents,
              impressions: dayData.impressions,
              clicks: dayData.clicks,
              conversions: dayData.conversions
            };
          }
        }
      }

      // If using connectors (Stripe, etc.) for conversions, fetch from stripe_conversions
      if (conversionSource === 'connectors') {
        const stripeConversions = await this.fetchStripeConversions(
          supabase,
          orgId,
          startDate,
          endDate
        );

        if (stripeConversions) {
          totalConversions = stripeConversions.total_conversions;

          // Merge Stripe conversions into time series by date
          for (const dayData of stripeConversions.by_date) {
            if (!timeSeriesByDate[dayData.date]) {
              timeSeriesByDate[dayData.date] = {
                date: dayData.date,
                total_spend_cents: 0,
                total_impressions: 0,
                total_clicks: 0,
                total_conversions: 0,
                by_platform: {}
              };
            }
            timeSeriesByDate[dayData.date].total_conversions += dayData.conversions;
          }
        }
      }

      // Convert time series object to sorted array
      const timeSeries = Object.values(timeSeriesByDate).sort((a: any, b: any) =>
        a.date.localeCompare(b.date)
      );

      const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
      const avgCpcCents = totalClicks > 0 ? Math.round(totalSpendCents / totalClicks) : 0;

      return success(c, {
        summary: {
          total_spend_cents: totalSpendCents,
          total_impressions: totalImpressions,
          total_clicks: totalClicks,
          total_conversions: totalConversions,
          average_ctr: Math.round(avgCtr * 100) / 100,
          average_cpc_cents: avgCpcCents,
          platforms_active: Object.keys(byPlatform)
        },
        by_platform: byPlatform,
        time_series: timeSeries
      });
    } catch (err) {
      console.error("Unified data fetch error:", err);
      return error(c, "SUPABASE_ERROR", "Failed to fetch unified data", 500);
    }
  }

  private async fetchPlatformMetrics(
    supabase: SupabaseClient,
    platform: string,
    orgId: string,
    startDate?: string,
    endDate?: string
  ): Promise<any | null> {
    try {
      // Build filters for unified view
      const platformValue = `${platform}_ads`;
      const filters = [
        `organization_id.eq.${orgId}`,
        `platform.eq.${platformValue}`
      ];
      if (startDate && endDate) {
        filters.push(`metric_date.gte.${startDate}`, `metric_date.lte.${endDate}`);
      }
      const query = filters.join('&');

      console.log(`[fetchPlatformMetrics] Platform: ${platform}, Filter: platform.eq.${platformValue}, Full query: ${query}`);

      // Fetch from unified view (clearlift.unified_ad_daily_performance)
      const metrics = await supabase.select(
        `unified_ad_daily_performance`,
        query,
        { limit: 10000 }
      );

      console.log(`[fetchPlatformMetrics] Returned ${metrics?.length || 0} rows for platform ${platform}`);

      if (!metrics || metrics.length === 0) {
        return null;
      }

      // Aggregate metrics
      let spendCents = 0;
      let impressions = 0;
      let clicks = 0;
      let conversions = 0;
      const uniqueCampaigns = new Set();

      for (const metric of metrics) {
        spendCents += (metric.spend_cents || 0);
        impressions += metric.impressions || 0;
        clicks += metric.clicks || 0;
        conversions += metric.conversions || 0;

        // Track unique campaigns
        if (metric.campaign_ref_id) {
          uniqueCampaigns.add(metric.campaign_ref_id);
        }
      }

      return {
        spend_cents: spendCents,
        impressions,
        clicks,
        conversions,
        campaigns: uniqueCampaigns.size
      };
    } catch (err) {
      console.error(`Failed to fetch metrics for ${platform}:`, err);
      return null;
    }
  }

  private async fetchPlatformTimeSeries(
    supabase: SupabaseClient,
    platform: string,
    orgId: string,
    startDate?: string,
    endDate?: string
  ): Promise<any[] | null> {
    try {
      // Build filters for unified view
      const filters = [
        `organization_id.eq.${orgId}`,
        `platform.eq.${platform}_ads`
      ];
      if (startDate && endDate) {
        filters.push(`metric_date.gte.${startDate}`, `metric_date.lte.${endDate}`);
      }
      const query = filters.join('&');

      // Fetch from unified view (clearlift.unified_ad_daily_performance)
      const metrics = await supabase.select(
        `unified_ad_daily_performance`,
        query,
        { limit: 10000, order: 'metric_date.asc' }
      );

      if (!metrics || metrics.length === 0) {
        return null;
      }

      // Group metrics by date
      const dailyData: Record<string, any> = {};

      for (const metric of metrics) {
        const date = metric.metric_date;

        if (!dailyData[date]) {
          dailyData[date] = {
            date,
            spend_cents: 0,
            impressions: 0,
            clicks: 0,
            conversions: 0
          };
        }

        dailyData[date].spend_cents += (metric.spend_cents || 0);
        dailyData[date].impressions += metric.impressions || 0;
        dailyData[date].clicks += metric.clicks || 0;
        dailyData[date].conversions += metric.conversions || 0;
      }

      // Convert to array and sort by date
      return Object.values(dailyData).sort((a: any, b: any) =>
        a.date.localeCompare(b.date)
      );
    } catch (err) {
      console.error(`Failed to fetch time series for ${platform}:`, err);
      return null;
    }
  }

  /**
   * Fetch conversions from Stripe (stripe_conversions table)
   */
  private async fetchStripeConversions(
    supabase: SupabaseClient,
    orgId: string,
    startDate?: string,
    endDate?: string
  ): Promise<{ total_conversions: number; by_date: any[] } | null> {
    try {
      // Build date filter for stripe_conversions table (uses stripe_created_at timestamp)
      const filters = [`organization_id.eq.${orgId}`];
      if (startDate && endDate) {
        filters.push(`stripe_created_at.gte.${startDate}T00:00:00Z`, `stripe_created_at.lte.${endDate}T23:59:59Z`);
      }
      const query = filters.join('&');

      // Fetch Stripe conversion data
      const conversions = await supabase.select(
        'stripe_conversions',
        query,
        { limit: 10000, order: 'stripe_created_at.asc' }
      );

      if (!conversions || conversions.length === 0) {
        return null;
      }

      // Group conversions by date
      const dailyData: Record<string, number> = {};
      let totalConversions = 0;

      for (const conversion of conversions) {
        // Extract date from stripe_created_at timestamp (YYYY-MM-DD)
        const timestamp = conversion.stripe_created_at;
        const date = timestamp ? timestamp.split('T')[0] : null;

        if (!date) continue;

        if (!dailyData[date]) {
          dailyData[date] = 0;
        }

        // Each row is a conversion (payment_intent)
        dailyData[date] += 1;
        totalConversions += 1;
      }

      // Convert to array
      const byDate = Object.entries(dailyData)
        .map(([date, conversions]) => ({ date, conversions }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        total_conversions: totalConversions,
        by_date: byDate
      };
    } catch (err) {
      console.error('Failed to fetch Stripe conversions:', err);
      return null;
    }
  }
}