/**
 * TikTok Ads Analytics Endpoints
 *
 * Provides clean access to TikTok Ads data from Supabase tiktok_ads schema
 * All endpoints use auth + requireOrg middleware for access control
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { TikTokAdsSupabaseAdapter, DateRange } from "../../../adapters/platforms/tiktok-supabase";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

/**
 * GET /v1/analytics/tiktok/campaigns
 */
export class GetTikTokCampaigns extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Get TikTok Ads campaigns",
    description: "Retrieve TikTok Ads campaigns for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "TikTok Ads campaigns data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                campaigns: z.array(z.any()),
                total: z.number()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();

    // Verify org access (already done by requireOrg middleware, but double-check)
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, query.query.org_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: supabaseKey
    });

    const adapter = new TikTokAdsSupabaseAdapter(supabase);

    try {
      const campaigns = await adapter.getCampaigns(query.query.org_id, {
        status: query.query.status,
        limit: query.query.limit,
        offset: query.query.offset
      });

      return success(c, {
        campaigns,
        total: campaigns.length
      });
    } catch (err: any) {
      console.error("Get TikTok campaigns error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch campaigns: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/tiktok/ad-groups
 */
export class GetTikTokAdGroups extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Get TikTok Ads ad groups",
    description: "Retrieve TikTok Ads ad groups for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "TikTok Ads ad groups data"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();

    // Verify org access
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, query.query.org_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: supabaseKey
    });

    const adapter = new TikTokAdsSupabaseAdapter(supabase);

    try {
      const adGroups = await adapter.getAdGroups(query.query.org_id, {
        campaignId: query.query.campaign_id,
        status: query.query.status,
        limit: query.query.limit,
        offset: query.query.offset
      });

      return success(c, {
        ad_groups: adGroups,
        total: adGroups.length
      });
    } catch (err: any) {
      console.error("Get TikTok ad groups error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch ad groups: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/tiktok/ads
 */
export class GetTikTokAds extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Get TikTok Ads ads",
    description: "Retrieve TikTok Ads ads for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        ad_group_id: z.string().optional().describe("Filter by ad group ID"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "TikTok Ads ads data"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();

    // Verify org access
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, query.query.org_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: supabaseKey
    });

    const adapter = new TikTokAdsSupabaseAdapter(supabase);

    try {
      const ads = await adapter.getAds(query.query.org_id, {
        campaignId: query.query.campaign_id,
        adGroupId: query.query.ad_group_id,
        status: query.query.status,
        limit: query.query.limit,
        offset: query.query.offset
      });

      return success(c, {
        ads,
        total: ads.length
      });
    } catch (err: any) {
      console.error("Get TikTok ads error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch ads: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/tiktok/metrics/daily
 */
export class GetTikTokMetrics extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Get TikTok Ads daily metrics",
    description: "Retrieve TikTok Ads daily metrics for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        level: z.enum(['campaign', 'ad_group', 'ad']).optional().default('campaign').describe("Metrics level"),
        campaign_id: z.string().optional().describe("Filter by campaign ID (for ad_group/ad level)"),
        ad_group_id: z.string().optional().describe("Filter by ad group ID (for ad level)"),
        ad_id: z.string().optional().describe("Filter by ad ID"),
        limit: z.coerce.number().min(1).max(10000).optional().default(1000),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "TikTok Ads daily metrics"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const query = await this.getValidatedData<typeof this.schema>();

    // Verify org access
    const { D1Adapter } = await import("../../../adapters/d1");
    const d1 = new D1Adapter(c.env.DB);
    const hasAccess = await d1.checkOrgAccess(session.user_id, query.query.org_id);

    if (!hasAccess) {
      return error(c, "FORBIDDEN", "No access to this organization", 403);
    }

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: supabaseKey
    });

    const adapter = new TikTokAdsSupabaseAdapter(supabase);

    const dateRange: DateRange = {
      start: query.query.start_date,
      end: query.query.end_date
    };

    try {
      let metrics;
      let summary;

      // Fetch metrics based on level
      if (query.query.level === 'campaign') {
        metrics = await adapter.getCampaignDailyMetrics(query.query.org_id, dateRange, {
          campaignId: query.query.campaign_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(query.query.org_id, dateRange, 'campaign');
      } else if (query.query.level === 'ad_group') {
        metrics = await adapter.getAdGroupDailyMetrics(query.query.org_id, dateRange, {
          adGroupId: query.query.ad_group_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(query.query.org_id, dateRange, 'ad_group');
      } else {
        metrics = await adapter.getAdDailyMetrics(query.query.org_id, dateRange, {
          adId: query.query.ad_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(query.query.org_id, dateRange, 'ad');
      }

      return success(c, {
        metrics,
        summary,
        total: metrics.length,
        date_range: dateRange,
        level: query.query.level
      });
    } catch (err: any) {
      console.error("Get TikTok metrics error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch metrics: ${err.message}`, 500);
    }
  }
}
