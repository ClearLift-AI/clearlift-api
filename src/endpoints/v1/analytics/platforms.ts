import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { GoogleAdsSupabaseAdapter } from "../../../adapters/platforms/google-supabase";
import { FacebookSupabaseAdapter } from "../../../adapters/platforms/facebook-supabase";
import { TikTokAdsSupabaseAdapter } from "../../../adapters/platforms/tiktok-supabase";

/**
 * DEPRECATED: GetPlatformData class removed - broken table naming
 * Use platform-specific endpoints instead:
 * - /v1/analytics/facebook/* for Facebook Ads
 * - /v1/analytics/google/* for Google Ads (to be implemented)
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
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const startDate = c.req.query("start_date");
    const endDate = c.req.query("end_date");

    // Access check already handled by requireOrg middleware

    // Check if org has any active platform connections
    // Only return data for platforms with active connections (prevents orphaned data leakage)
    const activeConnections = await c.env.DB.prepare(`
      SELECT DISTINCT platform FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).all<{ platform: string }>();

    const activePlatforms = activeConnections.results?.map(r => r.platform) || [];

    // If no active connections, return empty data
    if (activePlatforms.length === 0) {
      return success(c, {
        summary: {
          total_spend_cents: 0,
          total_impressions: 0,
          total_clicks: 0,
          total_conversions: 0,
          average_ctr: 0,
          average_cpc_cents: 0,
          platforms_active: []
        },
        by_platform: {},
        time_series: []
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

    const { UnifiedSupabaseAdapter } = await import("../../../adapters/platforms/unified-supabase");
    const adapter = new UnifiedSupabaseAdapter(supabase);

    try {
      const dateRange = startDate && endDate ? { start: startDate, end: endDate } : undefined;

      // Get aggregated data using the adapter
      let [summary, byPlatform, timeSeries] = await Promise.all([
        adapter.getSummary(orgId, dateRange),
        adapter.getMetricsByPlatform(orgId, dateRange),
        adapter.getTimeSeries(orgId, dateRange)
      ]);

      // "Best Available Data" fallback: if unified view is empty, query individual platform tables
      if (summary.total_spend_cents === 0 && Object.keys(byPlatform).length === 0 && activePlatforms.length > 0) {
        console.log(`Unified view empty for ${orgId}, falling back to individual platform tables`);
        const fallbackData = await this.fetchPlatformFallback(supabase, orgId, activePlatforms, dateRange);

        if (fallbackData.total_spend_cents > 0) {
          summary = {
            total_spend_cents: fallbackData.total_spend_cents,
            total_impressions: fallbackData.total_impressions,
            total_clicks: fallbackData.total_clicks,
            total_conversions: fallbackData.total_conversions,
            average_ctr: fallbackData.total_impressions > 0
              ? (fallbackData.total_clicks / fallbackData.total_impressions) * 100
              : 0,
            average_cpc_cents: fallbackData.total_clicks > 0
              ? Math.round(fallbackData.total_spend_cents / fallbackData.total_clicks)
              : 0,
            platforms_active: Object.keys(fallbackData.by_platform)
          };
          byPlatform = fallbackData.by_platform;
          // Note: timeSeries will remain empty for fallback - can be enhanced later
        }
      }

      // Get conversion source setting
      const conversionSettings = await c.env.DB.prepare(`
        SELECT conversion_source FROM ai_optimization_settings WHERE org_id = ?
      `).bind(orgId).first();
      const conversionSource = conversionSettings?.conversion_source || 'tag';

      let totalConversions = summary.total_conversions;

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
            const existingDay = timeSeries.find(ts => ts.date === dayData.date);
            if (existingDay) {
              existingDay.total_conversions += dayData.conversions;
            } else {
              timeSeries.push({
                date: dayData.date,
                total_spend_cents: 0,
                total_impressions: 0,
                total_clicks: 0,
                total_conversions: dayData.conversions,
                by_platform: {}
              });
            }
          }
          // Re-sort after adding Stripe data
          timeSeries.sort((a, b) => a.date.localeCompare(b.date));
        }
      }

      return success(c, {
        summary: {
          total_spend_cents: summary.total_spend_cents,
          total_impressions: summary.total_impressions,
          total_clicks: summary.total_clicks,
          total_conversions: totalConversions,
          average_ctr: Math.round(summary.average_ctr * 100) / 100,
          average_cpc_cents: summary.average_cpc_cents,
          platforms_active: summary.platforms_active
        },
        by_platform: byPlatform,
        time_series: timeSeries
      });
    } catch (err) {
      console.error("Unified data fetch error:", err);
      return error(c, "SUPABASE_ERROR", "Failed to fetch unified data", 500);
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

  /**
   * Fallback: Fetch data from individual platform campaign tables when unified view is empty
   * This implements the "best available data" pattern
   * Uses platform-specific adapters with correct schema/table names
   */
  private async fetchPlatformFallback(
    supabase: SupabaseClient,
    orgId: string,
    platforms: string[],
    dateRange?: { start: string; end: string }
  ): Promise<{
    total_spend_cents: number;
    total_impressions: number;
    total_clicks: number;
    total_conversions: number;
    by_platform: Record<string, { spend_cents: number; impressions: number; clicks: number; conversions: number; campaigns: number }>;
  }> {
    const result = {
      total_spend_cents: 0,
      total_impressions: 0,
      total_clicks: 0,
      total_conversions: 0,
      by_platform: {} as Record<string, { spend_cents: number; impressions: number; clicks: number; conversions: number; campaigns: number }>
    };

    // Build date range for queries (default: last 30 days)
    const effectiveDateRange = dateRange || {
      start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end: new Date().toISOString().split('T')[0]
    };

    for (const platform of platforms) {
      try {
        const normalizedPlatform = platform.toLowerCase().replace('_ads', '');

        if (normalizedPlatform === 'google') {
          // Use GoogleAdsSupabaseAdapter with google_ads schema
          const adapter = new GoogleAdsSupabaseAdapter(supabase);
          const campaigns = await adapter.getCampaignsWithMetrics(orgId, effectiveDateRange);

          let platformSpend = 0;
          let platformImpressions = 0;
          let platformClicks = 0;
          let platformConversions = 0;

          for (const campaign of campaigns) {
            platformSpend += campaign.metrics.spend_cents || 0;
            platformImpressions += campaign.metrics.impressions || 0;
            platformClicks += campaign.metrics.clicks || 0;
            platformConversions += campaign.metrics.conversions || 0;
          }

          result.by_platform['google'] = {
            spend_cents: platformSpend,
            impressions: platformImpressions,
            clicks: platformClicks,
            conversions: platformConversions,
            campaigns: campaigns.length
          };

          result.total_spend_cents += platformSpend;
          result.total_impressions += platformImpressions;
          result.total_clicks += platformClicks;
          result.total_conversions += platformConversions;

          console.log(`Platform fallback google: ${campaigns.length} campaigns, spend=${platformSpend}, conv=${platformConversions}`);

        } else if (normalizedPlatform === 'facebook' || normalizedPlatform === 'meta') {
          // Use FacebookSupabaseAdapter with facebook_ads schema
          const adapter = new FacebookSupabaseAdapter(supabase);
          const campaigns = await adapter.getCampaignsWithMetrics(orgId, effectiveDateRange);

          let platformSpend = 0;
          let platformImpressions = 0;
          let platformClicks = 0;
          let platformConversions = 0;

          for (const campaign of campaigns) {
            platformSpend += campaign.metrics.spend_cents || 0;
            platformImpressions += campaign.metrics.impressions || 0;
            platformClicks += campaign.metrics.clicks || 0;
            platformConversions += campaign.metrics.conversions || 0;
          }

          result.by_platform['facebook'] = {
            spend_cents: platformSpend,
            impressions: platformImpressions,
            clicks: platformClicks,
            conversions: platformConversions,
            campaigns: campaigns.length
          };

          result.total_spend_cents += platformSpend;
          result.total_impressions += platformImpressions;
          result.total_clicks += platformClicks;
          result.total_conversions += platformConversions;

          console.log(`Platform fallback facebook: ${campaigns.length} campaigns, spend=${platformSpend}, conv=${platformConversions}`);

        } else if (normalizedPlatform === 'tiktok') {
          // Use TikTokAdsSupabaseAdapter with tiktok_ads schema
          const adapter = new TikTokAdsSupabaseAdapter(supabase);
          const campaigns = await adapter.getCampaigns(orgId);
          const metrics = await adapter.getCampaignDailyMetrics(orgId, effectiveDateRange);

          // Aggregate metrics by campaign
          const metricsByCampaign: Record<string, { spend: number; impressions: number; clicks: number; conversions: number }> = {};
          for (const m of metrics) {
            const ref = (m as any).campaign_ref;
            if (!metricsByCampaign[ref]) {
              metricsByCampaign[ref] = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
            }
            metricsByCampaign[ref].spend += m.spend_cents || 0;
            metricsByCampaign[ref].impressions += m.impressions || 0;
            metricsByCampaign[ref].clicks += m.clicks || 0;
            metricsByCampaign[ref].conversions += m.conversions || 0;
          }

          let platformSpend = 0;
          let platformImpressions = 0;
          let platformClicks = 0;
          let platformConversions = 0;

          for (const campaign of campaigns) {
            const cm = metricsByCampaign[campaign.id] || { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
            platformSpend += cm.spend;
            platformImpressions += cm.impressions;
            platformClicks += cm.clicks;
            platformConversions += cm.conversions;
          }

          result.by_platform['tiktok'] = {
            spend_cents: platformSpend,
            impressions: platformImpressions,
            clicks: platformClicks,
            conversions: platformConversions,
            campaigns: campaigns.length
          };

          result.total_spend_cents += platformSpend;
          result.total_impressions += platformImpressions;
          result.total_clicks += platformClicks;
          result.total_conversions += platformConversions;

          console.log(`Platform fallback tiktok: ${campaigns.length} campaigns, spend=${platformSpend}, conv=${platformConversions}`);
        } else {
          console.warn(`Unknown platform for fallback: ${platform}`);
        }
      } catch (err) {
        console.warn(`Failed to fetch ${platform} campaigns for fallback:`, err);
      }
    }

    return result;
  }
}