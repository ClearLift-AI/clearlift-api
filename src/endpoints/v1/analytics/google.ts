/**
 * Google Ads Analytics Endpoints
 *
 * Provides clean access to Google Ads data from Supabase google_ads schema
 * All endpoints use auth + requireOrg middleware for access control
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { GoogleAdsSupabaseAdapter, DateRange } from "../../../adapters/platforms/google-supabase";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

/**
 * GET /v1/analytics/google/campaigns
 */
export class GetGoogleCampaigns extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Get Google Ads campaigns",
    description: "Retrieve Google Ads campaigns for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Google Ads campaigns data",
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

    const adapter = new GoogleAdsSupabaseAdapter(supabase);

    try {
      const campaigns = await adapter.getCampaigns(query.query.org_id, {
        status: query.query.status,
        limit: query.query.limit,
        offset: query.query.offset
      });

      // Transform to frontend expected format
      const results = campaigns.map(c => ({
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        status: c.campaign_status,
        metrics: {
          impressions: 0,
          clicks: 0,
          spend: 0,
          conversions: 0,
          revenue: 0
        }
      }));

      return success(c, {
        platform: 'google',
        results,
        summary: {
          total_impressions: 0,
          total_clicks: 0,
          total_spend: 0,
          total_conversions: 0,
          average_ctr: 0
        }
      });
    } catch (err: any) {
      console.error("Get Google campaigns error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch campaigns: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/google/ad-groups
 */
export class GetGoogleAdGroups extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Get Google Ads ad groups",
    description: "Retrieve Google Ads ad groups for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Google Ads ad groups data"
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

    const adapter = new GoogleAdsSupabaseAdapter(supabase);

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
      console.error("Get Google ad groups error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch ad groups: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/google/ads
 */
export class GetGoogleAds extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Get Google Ads ads",
    description: "Retrieve Google Ads ads for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        ad_group_id: z.string().optional().describe("Filter by ad group ID"),
        status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Google Ads ads data"
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

    const adapter = new GoogleAdsSupabaseAdapter(supabase);

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
      console.error("Get Google ads error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch ads: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/google/metrics/daily
 */
export class GetGoogleMetrics extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Get Google Ads daily metrics",
    description: "Retrieve Google Ads daily metrics for an organization",
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
        description: "Google Ads daily metrics"
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

    const adapter = new GoogleAdsSupabaseAdapter(supabase);

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
      console.error("Get Google metrics error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch metrics: ${err.message}`, 500);
    }
  }
}
