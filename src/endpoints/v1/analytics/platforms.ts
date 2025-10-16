import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";

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

    // Get Supabase client
    if (!c.env.SUPABASE_SECRET_KEY) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: c.env.SUPABASE_SECRET_KEY
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
                  average_ctr: z.number(),
                  average_cpc_cents: z.number(),
                  platforms_active: z.array(z.string())
                }),
                by_platform: z.record(z.string(), z.object({
                  spend_cents: z.number(),
                  impressions: z.number(),
                  clicks: z.number(),
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

    // Get active connections for this org
    const connections = await c.env.DB.prepare(`
      SELECT platform FROM platform_connections
      WHERE organization_id = ? AND is_active = 1
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

    // Get Supabase client
    if (!c.env.SUPABASE_SECRET_KEY) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: c.env.SUPABASE_SECRET_KEY
    });

    try {
      const byPlatform: Record<string, any> = {};
      let totalSpendCents = 0;
      let totalImpressions = 0;
      let totalClicks = 0;

      // Fetch data for each connected platform
      for (const conn of connections.results) {
        const platform = conn.platform as string;
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
        }
      }

      const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
      const avgCpcCents = totalClicks > 0 ? Math.round(totalSpendCents / totalClicks) : 0;

      return success(c, {
        summary: {
          total_spend_cents: totalSpendCents,
          total_impressions: totalImpressions,
          total_clicks: totalClicks,
          average_ctr: Math.round(avgCtr * 100) / 100,
          average_cpc_cents: avgCpcCents,
          platforms_active: Object.keys(byPlatform)
        },
        by_platform: byPlatform
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
      // Build date filter
      const filters = [`organization_id.eq.${orgId}`];
      if (startDate && endDate) {
        filters.push(`date.gte.${startDate}`, `date.lte.${endDate}`);
      }
      const query = filters.join('&');

      // Fetch campaign data to aggregate metrics
      const campaigns = await supabase.select(
        `${platform}_ads_campaigns`,
        query,
        { limit: 1000 }
      );

      if (!campaigns || campaigns.length === 0) {
        return null;
      }

      // Aggregate metrics
      let spendCents = 0;
      let impressions = 0;
      let clicks = 0;

      for (const campaign of campaigns) {
        spendCents += campaign.spend_cents || 0;
        impressions += campaign.impressions || 0;
        clicks += campaign.clicks || 0;
      }

      return {
        spend_cents: spendCents,
        impressions,
        clicks,
        campaigns: campaigns.length
      };
    } catch (err) {
      console.error(`Failed to fetch metrics for ${platform}:`, err);
      return null;
    }
  }
}