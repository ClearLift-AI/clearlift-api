import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { FacebookAdapter } from "../../../adapters/platforms/facebook";
import { success, error, getDateRange, getPagination } from "../../../utils/response";

/**
 * GET /v1/analytics/ads/:platform_slug - Get ad platform data
 */
export class GetAds extends OpenAPIRoute {
  public schema = {
    tags: ["Analytics"],
    summary: "Get ad platform performance data",
    description: "Fetches ad performance data from various platforms (Facebook, Google, TikTok, etc.) with flexible aggregation",
    operationId: "get-ads",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        platform_slug: z.enum(["facebook", "google", "tiktok"]).describe("Platform identifier")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        ad_id: z.string().optional().describe("Filter by ad ID"),
        group_by: z.enum(["campaign", "ad", "date", "campaign_date", "none"]).optional().describe("Aggregation level (default: none)"),
        limit: z.string().optional().describe("Pagination limit"),
        offset: z.string().optional().describe("Pagination offset"),
        sort_by: z.enum(["spend", "impressions", "clicks", "conversions"]).optional().describe("Sort field"),
        order: z.enum(["asc", "desc"]).optional().describe("Sort order")
      })
    },
    responses: {
      "200": {
        description: "Ad platform data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                platform: z.string(),
                results: z.any(),
                summary: z.any()
              }),
              meta: z.object({
                timestamp: z.string(),
                date_range: z.object({
                  start_date: z.string(),
                  end_date: z.string()
                })
              })
            })
          }
        }
      },
      "400": { description: "Invalid platform or parameters" },
      "401": { description: "Unauthorized" },
      "403": { description: "No organization selected" },
      "500": { description: "Query failed" }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    const data = await this.getValidatedData<typeof this.schema>();
    const { platform_slug } = data.params;

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const dateRange = getDateRange(c);
    const { limit, offset } = getPagination(c);
    const groupBy = c.req.query("group_by") || "none";
    const campaignId = c.req.query("campaign_id");
    const adId = c.req.query("ad_id");
    const sortBy = c.req.query("sort_by");
    const order = c.req.query("order") as "asc" | "desc" | undefined;

    // Get Supabase secret key
    let supabaseKey: string;
    if (typeof c.env.SUPABASE_SECRET_KEY === 'string') {
      supabaseKey = c.env.SUPABASE_SECRET_KEY;
    } else if (c.env.SUPABASE_SECRET_KEY && typeof c.env.SUPABASE_SECRET_KEY.get === 'function') {
      supabaseKey = await c.env.SUPABASE_SECRET_KEY.get();
    } else {
      return error(c, "CONFIGURATION_ERROR", "Supabase key not configured", 500);
    }

    try {
      // Route to appropriate platform adapter
      let results: any;
      let summary: any;

      switch (platform_slug) {
        case "facebook": {
          const fb = new FacebookAdapter(c.env.SUPABASE_URL, supabaseKey);

          // Get data based on grouping
          switch (groupBy) {
            case "campaign": {
              results = await fb.getCampaigns(orgId, dateRange, { limit, offset, sort_by: sortBy, order });
              summary = await fb.getSummary(orgId, dateRange);
              break;
            }
            case "ad": {
              results = await fb.getAds(orgId, dateRange, { campaign_id: campaignId, limit, offset });
              summary = await fb.getSummary(orgId, dateRange);
              break;
            }
            case "date": {
              results = await fb.getDailyMetrics(orgId, dateRange, { campaign_id: campaignId, group_by: "day" });
              summary = await fb.getSummary(orgId, dateRange);
              break;
            }
            case "campaign_date": {
              // For campaign+date breakdown, fetch raw data and group client-side
              const rawData = await fb.getAds(orgId, dateRange, { campaign_id: campaignId });
              results = this.groupByCampaignAndDate(rawData);
              summary = await fb.getSummary(orgId, dateRange);
              break;
            }
            case "none":
            default: {
              // Just return summary
              summary = await fb.getSummary(orgId, dateRange);
              results = null;
              break;
            }
          }
          break;
        }
        case "google":
        case "tiktok": {
          return error(c, "NOT_IMPLEMENTED", `Platform '${platform_slug}' not yet implemented`, 400);
        }
        default: {
          return error(c, "INVALID_PLATFORM", `Unknown platform: ${platform_slug}`, 400);
        }
      }

      return success(
        c,
        {
          platform: platform_slug,
          results,
          summary
        },
        { date_range: dateRange }
      );
    } catch (err) {
      console.error(`Failed to fetch ${platform_slug} ads:`, err);
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch ad data";
      return error(c, "QUERY_FAILED", errorMessage, 500);
    }
  }

  /**
   * Group ad performance data by campaign and date
   */
  private groupByCampaignAndDate(ads: any[]): any[] {
    const groupMap = new Map<string, any>();

    for (const ad of ads) {
      const key = `${ad.campaign_id}|${ad.date_reported}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          campaign_id: ad.campaign_id,
          campaign_name: ad.campaign_name,
          date: ad.date_reported,
          metrics: {
            impressions: 0,
            clicks: 0,
            spend: 0,
            conversions: 0,
            revenue: 0
          }
        });
      }

      const group = groupMap.get(key)!;
      group.metrics.impressions += ad.metrics.impressions || 0;
      group.metrics.clicks += ad.metrics.clicks || 0;
      group.metrics.spend += ad.metrics.spend || 0;
      group.metrics.conversions += ad.metrics.conversions || 0;
      group.metrics.revenue += ad.metrics.revenue || 0;
    }

    return Array.from(groupMap.values())
      .sort((a, b) => {
        const dateCompare = a.date.localeCompare(b.date);
        if (dateCompare !== 0) return dateCompare;
        return a.campaign_name.localeCompare(b.campaign_name);
      });
  }
}