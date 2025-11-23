/**
 * Facebook Ads Analytics Endpoints
 *
 * Provides clean access to Facebook Ads data from Supabase facebook_ads schema
 * All endpoints use auth + requireOrg middleware for access control
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { FacebookSupabaseAdapter, DateRange } from "../../../adapters/platforms/facebook-supabase";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

/**
 * GET /v1/analytics/facebook/campaigns
 */
export class GetFacebookCampaigns extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Get Facebook campaigns",
    description: "Retrieve Facebook Ads campaigns for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Facebook campaigns data",
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

    const adapter = new FacebookSupabaseAdapter(supabase);

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
      console.error("Get Facebook campaigns error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch campaigns: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/ad-sets
 */
export class GetFacebookAdSets extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Get Facebook ad sets",
    description: "Retrieve Facebook Ads ad sets for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Facebook ad sets data"
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

    const adapter = new FacebookSupabaseAdapter(supabase);

    try {
      const adSets = await adapter.getAdSets(query.query.org_id, {
        campaignId: query.query.campaign_id,
        status: query.query.status,
        limit: query.query.limit,
        offset: query.query.offset
      });

      return success(c, {
        ad_sets: adSets,
        total: adSets.length
      });
    } catch (err: any) {
      console.error("Get Facebook ad sets error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch ad sets: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/creatives
 */
export class GetFacebookCreatives extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Get Facebook creatives",
    description: "Retrieve Facebook Ads creatives for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Facebook creatives data"
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

    const adapter = new FacebookSupabaseAdapter(supabase);

    try {
      const creatives = await adapter.getCreatives(query.query.org_id, {
        limit: query.query.limit,
        offset: query.query.offset
      });

      return success(c, {
        creatives,
        total: creatives.length
      });
    } catch (err: any) {
      console.error("Get Facebook creatives error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch creatives: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/ads
 */
export class GetFacebookAds extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Get Facebook ads",
    description: "Retrieve Facebook Ads ads for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        ad_set_id: z.string().optional().describe("Filter by ad set ID"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Facebook ads data"
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

    const adapter = new FacebookSupabaseAdapter(supabase);

    try {
      const ads = await adapter.getAds(query.query.org_id, {
        campaignId: query.query.campaign_id,
        adSetId: query.query.ad_set_id,
        status: query.query.status,
        limit: query.query.limit,
        offset: query.query.offset
      });

      return success(c, {
        ads,
        total: ads.length
      });
    } catch (err: any) {
      console.error("Get Facebook ads error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch ads: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/metrics/daily
 */
export class GetFacebookMetrics extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Get Facebook daily metrics",
    description: "Retrieve Facebook Ads daily metrics for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
        level: z.enum(['campaign', 'ad_set', 'ad']).optional().default('campaign').describe("Metrics level"),
        campaign_id: z.string().optional().describe("Filter by campaign ID (for ad_set/ad level)"),
        ad_set_id: z.string().optional().describe("Filter by ad set ID (for ad level)"),
        ad_id: z.string().optional().describe("Filter by ad ID"),
        limit: z.coerce.number().min(1).max(10000).optional().default(1000),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Facebook daily metrics"
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

    const adapter = new FacebookSupabaseAdapter(supabase);

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
      } else if (query.query.level === 'ad_set') {
        metrics = await adapter.getAdSetDailyMetrics(query.query.org_id, dateRange, {
          adSetId: query.query.ad_set_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(query.query.org_id, dateRange, 'ad_set');
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
      console.error("Get Facebook metrics error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch metrics: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/facebook/campaigns/:campaign_id/status
 */
export class UpdateFacebookCampaignStatus extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Update Facebook campaign status",
    description: "Pause or resume a Facebook campaign",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        campaign_id: z.string()
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      }),
      body: contentJson(
        z.object({
          status: z.enum(['ACTIVE', 'PAUSED']).describe("New status for the campaign")
        })
      )
    },
    responses: {
      "200": {
        description: "Campaign status updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { campaign_id } = data.params;
    const { status } = data.body;

    // Authorization check handled by requireOrgAdmin middleware

    try {
      // Get Facebook connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = new ConnectorService(c.env.DB, encryptionKey);
      await new Promise(resolve => setTimeout(resolve, 100));
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update campaign status via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const fbProvider = new FacebookAdsOAuthProvider(
        await getSecret(c.env.FACEBOOK_APP_ID),
        await getSecret(c.env.FACEBOOK_APP_SECRET),
        ''
      );

      await fbProvider.updateCampaignStatus(accessToken, campaign_id, status);

      return success(c, {
        campaign_id,
        status,
        message: `Campaign ${status === 'ACTIVE' ? 'resumed' : 'paused'} successfully`
      });
    } catch (err: any) {
      console.error("Update campaign status error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update campaign status: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/facebook/ad-sets/:ad_set_id/status
 */
export class UpdateFacebookAdSetStatus extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Update Facebook ad set status",
    description: "Pause or resume a Facebook ad set",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        ad_set_id: z.string()
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      }),
      body: contentJson(
        z.object({
          status: z.enum(['ACTIVE', 'PAUSED']).describe("New status for the ad set")
        })
      )
    },
    responses: {
      "200": {
        description: "Ad set status updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_set_id } = data.params;
    const { status } = data.body;

    // Authorization check handled by requireOrgAdmin middleware

    try {
      // Get Facebook connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = new ConnectorService(c.env.DB, encryptionKey);
      await new Promise(resolve => setTimeout(resolve, 100));
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update ad set status via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const fbProvider = new FacebookAdsOAuthProvider(
        await getSecret(c.env.FACEBOOK_APP_ID),
        await getSecret(c.env.FACEBOOK_APP_SECRET),
        ''
      );

      await fbProvider.updateAdSetStatus(accessToken, ad_set_id, status);

      return success(c, {
        ad_set_id,
        status,
        message: `Ad set ${status === 'ACTIVE' ? 'resumed' : 'paused'} successfully`
      });
    } catch (err: any) {
      console.error("Update ad set status error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad set status: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/facebook/ads/:ad_id/status
 */
export class UpdateFacebookAdStatus extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Update Facebook ad status",
    description: "Pause or resume a Facebook ad",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        ad_id: z.string()
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      }),
      body: contentJson(
        z.object({
          status: z.enum(['ACTIVE', 'PAUSED']).describe("New status for the ad")
        })
      )
    },
    responses: {
      "200": {
        description: "Ad status updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_id } = data.params;
    const { status } = data.body;

    // Authorization check handled by requireOrgAdmin middleware

    try {
      // Get Facebook connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = new ConnectorService(c.env.DB, encryptionKey);
      await new Promise(resolve => setTimeout(resolve, 100));
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update ad status via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const fbProvider = new FacebookAdsOAuthProvider(
        await getSecret(c.env.FACEBOOK_APP_ID),
        await getSecret(c.env.FACEBOOK_APP_SECRET),
        ''
      );

      await fbProvider.updateAdStatus(accessToken, ad_id, status);

      return success(c, {
        ad_id,
        status,
        message: `Ad ${status === 'ACTIVE' ? 'resumed' : 'paused'} successfully`
      });
    } catch (err: any) {
      console.error("Update ad status error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad status: ${err.message}`, 500);
    }
  }
}
