/**
 * Facebook Ads Analytics Endpoints
 *
 * Provides clean access to Facebook Ads data from Supabase facebook_ads schema
 * All endpoints use auth + requireOrg middleware for access control
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { FacebookSupabaseAdapter, DateRange } from "../../../adapters/platforms/facebook-supabase";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { AGE_LIMITS, BUDGET_LIMITS } from "../../../constants/facebook";

/**
 * GET /v1/analytics/facebook/campaigns
 */
export class GetFacebookCampaigns extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Get Facebook campaigns with metrics",
    description: "Retrieve Facebook Ads campaigns with aggregated metrics for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (YYYY-MM-DD) for metrics aggregation"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (YYYY-MM-DD) for metrics aggregation"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Facebook campaigns data with metrics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                platform: z.string(),
                results: z.array(z.object({
                  campaign_id: z.string(),
                  campaign_name: z.string(),
                  status: z.string(),
                  last_updated: z.string().optional(),
                  metrics: z.object({
                    impressions: z.number(),
                    clicks: z.number(),
                    spend: z.number(),
                    conversions: z.number(),
                    revenue: z.number()
                  })
                })),
                summary: z.object({
                  total_impressions: z.number(),
                  total_clicks: z.number(),
                  total_spend: z.number(),
                  total_conversions: z.number(),
                  average_ctr: z.number()
                })
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    // Check if org has an active Facebook connection
    // Prevents returning orphaned data for orgs without active connections
    const hasConnection = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections
      WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
      LIMIT 1
    `).bind(orgId).first();

    if (!hasConnection) {
      return success(c, {
        platform: 'facebook',
        results: [],
        summary: {
          total_impressions: 0,
          total_clicks: 0,
          total_spend: 0,
          total_conversions: 0,
          average_ctr: 0
        }
      });
    }

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    const adapter = new FacebookSupabaseAdapter(supabase);

    try {
      // Default date range: last 30 days if not provided
      const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
      const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const dateRange: DateRange = { start: startDate, end: endDate };

      console.log('[Facebook Campaigns] Date range requested:', { startDate, endDate });

      // Fetch campaigns WITH metrics using the new method
      const campaignsWithMetrics = await adapter.getCampaignsWithMetrics(
        orgId,
        dateRange,
        {
          status: query.query.status,
          limit: query.query.limit,
          offset: query.query.offset
        }
      );

      console.log('[Facebook Campaigns] Campaigns with metrics returned:', campaignsWithMetrics.length);

      // Transform to frontend expected format
      const results = campaignsWithMetrics.map(c => ({
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        status: c.campaign_status,
        last_updated: c.last_synced_at || c.updated_at,
        metrics: {
          impressions: c.metrics.impressions,
          clicks: c.metrics.clicks,
          spend: c.metrics.spend_cents / 100, // Convert cents to dollars for frontend
          conversions: c.metrics.conversions,
          revenue: 0 // Revenue comes from Stripe, not ad platforms
        }
      }));

      // Debug: Log first campaign's metrics to verify date filtering
      if (results.length > 0) {
        console.log('[Facebook Campaigns] Sample campaign metrics:', {
          name: results[0].campaign_name,
          spend: results[0].metrics.spend,
          impressions: results[0].metrics.impressions
        });
      }

      // Calculate summary from results
      const summary = results.reduce(
        (acc, campaign) => ({
          total_impressions: acc.total_impressions + campaign.metrics.impressions,
          total_clicks: acc.total_clicks + campaign.metrics.clicks,
          total_spend: acc.total_spend + campaign.metrics.spend,
          total_conversions: acc.total_conversions + campaign.metrics.conversions,
          average_ctr: 0 // Calculate after
        }),
        { total_impressions: 0, total_clicks: 0, total_spend: 0, total_conversions: 0, average_ctr: 0 }
      );

      // Calculate average CTR
      if (summary.total_impressions > 0) {
        summary.average_ctr = (summary.total_clicks / summary.total_impressions) * 100;
      }

      return success(c, {
        platform: 'facebook',
        results,
        summary
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
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    const adapter = new FacebookSupabaseAdapter(supabase);

    try {
      const adSets = await adapter.getAdSets(orgId, {
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
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    const adapter = new FacebookSupabaseAdapter(supabase);

    try {
      const creatives = await adapter.getCreatives(orgId, {
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
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    const adapter = new FacebookSupabaseAdapter(supabase);

    try {
      const ads = await adapter.getAds(orgId, {
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
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
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
        metrics = await adapter.getCampaignDailyMetrics(orgId, dateRange, {
          campaignId: query.query.campaign_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(orgId, dateRange, 'campaign');
      } else if (query.query.level === 'ad_set') {
        metrics = await adapter.getAdSetDailyMetrics(orgId, dateRange, {
          adSetId: query.query.ad_set_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(orgId, dateRange, 'ad_set');
      } else {
        metrics = await adapter.getAdDailyMetrics(orgId, dateRange, {
          adId: query.query.ad_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(orgId, dateRange, 'ad');
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
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      if (!encryptionKey) {
        return error(c, "CONFIG_ERROR", "Encryption key not configured", 500);
      }
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update campaign status via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "Facebook credentials not configured", 500);
      }
      const fbProvider = new FacebookAdsOAuthProvider(appId, appSecret, '');

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
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      if (!encryptionKey) {
        return error(c, "CONFIG_ERROR", "Encryption key not configured", 500);
      }
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update ad set status via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "Facebook credentials not configured", 500);
      }
      const fbProvider = new FacebookAdsOAuthProvider(appId, appSecret, '');

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
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      if (!encryptionKey) {
        return error(c, "CONFIG_ERROR", "Encryption key not configured", 500);
      }
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update ad status via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "Facebook credentials not configured", 500);
      }
      const fbProvider = new FacebookAdsOAuthProvider(appId, appSecret, '');

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

/**
 * PATCH /v1/analytics/facebook/campaigns/:campaign_id/budget
 */
export class UpdateFacebookCampaignBudget extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Update Facebook campaign budget",
    description: "Update daily or lifetime budget for a Facebook campaign. Must specify either daily_budget or lifetime_budget, not both.",
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
          daily_budget: z.number().min(BUDGET_LIMITS.DAILY_MIN_CENTS).optional().describe(`Daily budget in cents (minimum: $${BUDGET_LIMITS.DAILY_MIN_CENTS / 100})`),
          lifetime_budget: z.number().min(BUDGET_LIMITS.LIFETIME_MIN_CENTS).optional().describe(`Lifetime budget in cents (minimum: $${BUDGET_LIMITS.LIFETIME_MIN_CENTS / 100})`),
          budget_type: z.enum(['campaign', 'adset']).optional().describe("v24.0: Campaign Budget Optimization type")
        }).refine(
          data => (data.daily_budget !== undefined) !== (data.lifetime_budget !== undefined),
          { message: "Must provide either daily_budget or lifetime_budget, not both" }
        )
      )
    },
    responses: {
      "200": {
        description: "Campaign budget updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { campaign_id } = data.params;
    const budget = data.body;

    // Authorization check handled by requireOrgAdmin middleware

    try {
      // Get Facebook connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      if (!encryptionKey) {
        return error(c, "CONFIG_ERROR", "Encryption key not configured", 500);
      }
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update campaign budget via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "Facebook credentials not configured", 500);
      }
      const fbProvider = new FacebookAdsOAuthProvider(appId, appSecret, '');

      await fbProvider.updateCampaignBudget(accessToken, campaign_id, budget);

      return success(c, {
        campaign_id,
        budget,
        message: `Campaign budget updated successfully`
      });
    } catch (err: any) {
      console.error("Update campaign budget error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update campaign budget: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/facebook/ad-sets/:ad_set_id/budget
 */
export class UpdateFacebookAdSetBudget extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Update Facebook ad set budget",
    description: "Update daily or lifetime budget for a Facebook ad set. Must specify either daily_budget or lifetime_budget, not both.",
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
          daily_budget: z.number().min(BUDGET_LIMITS.DAILY_MIN_CENTS).optional().describe(`Daily budget in cents (minimum: $${BUDGET_LIMITS.DAILY_MIN_CENTS / 100})`),
          lifetime_budget: z.number().min(BUDGET_LIMITS.LIFETIME_MIN_CENTS).optional().describe(`Lifetime budget in cents (minimum: $${BUDGET_LIMITS.LIFETIME_MIN_CENTS / 100})`)
        }).refine(
          data => (data.daily_budget !== undefined) !== (data.lifetime_budget !== undefined),
          { message: "Must provide either daily_budget or lifetime_budget, not both" }
        )
      )
    },
    responses: {
      "200": {
        description: "Ad set budget updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_set_id } = data.params;
    const budget = data.body;

    // Authorization check handled by requireOrgAdmin middleware

    try {
      // Get Facebook connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      if (!encryptionKey) {
        return error(c, "CONFIG_ERROR", "Encryption key not configured", 500);
      }
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update ad set budget via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "Facebook credentials not configured", 500);
      }
      const fbProvider = new FacebookAdsOAuthProvider(appId, appSecret, '');

      await fbProvider.updateAdSetBudget(accessToken, ad_set_id, budget);

      return success(c, {
        ad_set_id,
        budget,
        message: `Ad set budget updated successfully`
      });
    } catch (err: any) {
      console.error("Update ad set budget error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad set budget: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/facebook/ad-sets/:ad_set_id/targeting
 */
export class UpdateFacebookAdSetTargeting extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Update Facebook ad set targeting",
    description: "Update targeting parameters for a Facebook ad set (demographics, interests, locations, etc.)",
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
          targeting: z.object({
            geo_locations: z.object({
              countries: z.array(z.string()).optional().describe("ISO country codes, e.g., ['US', 'CA']"),
              regions: z.array(z.object({ key: z.string() })).optional().describe("Region IDs"),
              cities: z.array(z.object({
                key: z.string(),
                radius: z.number().optional(),
                distance_unit: z.enum(['mile', 'kilometer']).optional()
              })).optional(),
              location_types: z.array(z.enum(['home', 'recent'])).optional()
            }).optional(),
            age_min: z.number().min(AGE_LIMITS.MIN).max(AGE_LIMITS.MAX).optional().describe(`Minimum age for targeting (${AGE_LIMITS.MIN}-${AGE_LIMITS.MAX})`),
            age_max: z.number().min(AGE_LIMITS.MIN).max(AGE_LIMITS.MAX).optional().describe(`Maximum age for targeting (${AGE_LIMITS.MIN}-${AGE_LIMITS.MAX})`),
            genders: z.array(z.union([z.literal(1), z.literal(2)])).optional().describe("1 = male, 2 = female"),
            interests: z.array(z.object({
              id: z.string(),
              name: z.string().optional()
            })).optional(),
            behaviors: z.array(z.object({
              id: z.string(),
              name: z.string().optional()
            })).optional(),
            flexible_spec: z.array(z.object({
              interests: z.array(z.object({
                id: z.string(),
                name: z.string().optional()
              })).optional(),
              behaviors: z.array(z.object({
                id: z.string(),
                name: z.string().optional()
              })).optional()
            })).optional(),
            exclusions: z.object({
              interests: z.array(z.object({
                id: z.string(),
                name: z.string().optional()
              })).optional(),
              behaviors: z.array(z.object({
                id: z.string(),
                name: z.string().optional()
              })).optional()
            }).optional(),
            device_platforms: z.array(z.enum(['mobile', 'desktop'])).optional(),
            publisher_platforms: z.array(z.enum(['facebook', 'instagram', 'audience_network', 'messenger'])).optional(),
            facebook_positions: z.array(z.enum(['feed', 'right_hand_column', 'instant_article', 'instream_video', 'marketplace', 'story', 'search'])).optional(),
            instagram_positions: z.array(z.enum(['stream', 'story', 'explore'])).optional()
          }),
          placement_soft_opt_out: z.boolean().optional().describe("v24.0: Allow up to 5% spend on excluded placements for better performance")
        })
      )
    },
    responses: {
      "200": {
        description: "Ad set targeting updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const session = c.get("session");
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_set_id } = data.params;
    const { targeting, placement_soft_opt_out } = data.body;

    // Authorization check handled by requireOrgAdmin middleware

    try {
      // Get Facebook connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
      }

      // Get access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      if (!encryptionKey) {
        return error(c, "CONFIG_ERROR", "Encryption key not configured", 500);
      }
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "NO_TOKEN", "Failed to retrieve access token", 500);
      }

      // Update ad set targeting via Facebook API
      const { FacebookAdsOAuthProvider } = await import('../../../services/oauth/facebook');
      const appId = await getSecret(c.env.FACEBOOK_APP_ID);
      const appSecret = await getSecret(c.env.FACEBOOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "Facebook credentials not configured", 500);
      }
      const fbProvider = new FacebookAdsOAuthProvider(appId, appSecret, '');

      await fbProvider.updateAdSetTargeting(
        accessToken,
        ad_set_id,
        targeting,
        placement_soft_opt_out !== undefined ? { placement_soft_opt_out } : undefined
      );

      return success(c, {
        ad_set_id,
        message: `Ad set targeting updated successfully`
      });
    } catch (err: any) {
      console.error("Update ad set targeting error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad set targeting: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/pages
 *
 * Retrieves Facebook Pages connected to the user's account.
 * Demonstrates usage of pages_show_list permission for Meta App Review.
 */
export class GetFacebookPages extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Pages"],
    summary: "Get connected Facebook Pages",
    description: "Retrieves Facebook Pages connected via OAuth. Demonstrates pages_show_list permission usage.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        limit: z.coerce.number().min(1).max(100).optional().default(25)
      })
    },
    responses: {
      "200": {
        description: "Connected Facebook Pages",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                pages: z.array(z.object({
                  page_id: z.string(),
                  page_name: z.string(),
                  category: z.string().nullable(),
                  fan_count: z.number(),
                  has_access_token: z.boolean()
                })),
                total: z.number()
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    // Check if org has an active Facebook connection
    const hasConnection = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections
      WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
      LIMIT 1
    `).bind(orgId).first();

    if (!hasConnection) {
      return success(c, {
        pages: [],
        total: 0,
        message: "No active Facebook connection found"
      });
    }

    // Initialize Supabase client to read pages from facebook_ads.pages
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    try {
      // Query pages from Supabase facebook_ads.pages table
      const pagesResult = await supabase.query(
        'pages',
        {
          select: 'page_id,page_name,category,fan_count,access_token,created_at',
          organization_id: `eq.${orgId}`,
          deleted_at: 'is.null',
          limit: query.query.limit,
          order: 'fan_count.desc'
        },
        'facebook_ads'
      );

      const pages = (pagesResult || []).map((p: any) => ({
        page_id: p.page_id,
        page_name: p.page_name,
        category: p.category || null,
        fan_count: p.fan_count || 0,
        has_access_token: !!p.access_token
      }));

      return success(c, {
        pages,
        total: pages.length
      });
    } catch (err: any) {
      console.error("Get Facebook pages error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch pages: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/pages/:page_id/insights
 *
 * Retrieves insights for a specific Facebook Page.
 * Demonstrates usage of pages_read_engagement permission for Meta App Review.
 *
 * Note: As of November 2025, 'impressions' is deprecated in favor of 'views'.
 */
export class GetFacebookPageInsights extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Pages"],
    summary: "Get Facebook Page insights",
    description: "Retrieves engagement insights for a connected Facebook Page. Demonstrates pages_read_engagement permission usage.",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        page_id: z.string().describe("Facebook Page ID")
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        period: z.enum(['day', 'week', 'days_28']).optional().default('day').describe("Insight period"),
        date_preset: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']).optional()
      })
    },
    responses: {
      "200": {
        description: "Facebook Page insights data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                page_id: z.string(),
                page_name: z.string(),
                period: z.string(),
                insights: z.object({
                  page_views: z.number().describe("Total page views (replaces deprecated impressions)"),
                  page_engaged_users: z.number().describe("Unique users who engaged with the page"),
                  page_post_engagements: z.number().describe("Total post engagements"),
                  page_fan_adds: z.number().describe("New page likes/follows"),
                  page_fan_removes: z.number().describe("Page unlikes/unfollows")
                })
              })
            })
          }
        }
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { page_id } = data.params;
    const { period, date_preset } = data.query;

    // Get Facebook connection for this org
    const connection = await c.env.DB.prepare(`
      SELECT id, account_id
      FROM platform_connections
      WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
      LIMIT 1
    `).bind(orgId).first<{ id: string; account_id: string }>();

    if (!connection) {
      return error(c, "NO_CONNECTION", "No active Facebook connection found for this organization", 404);
    }

    // Get the page-specific access token from Supabase
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    try {
      // Get page record with access token
      const pageResult = await supabase.query(
        'pages',
        {
          select: 'page_id,page_name,access_token',
          organization_id: `eq.${orgId}`,
          page_id: `eq.${page_id}`,
          deleted_at: 'is.null',
          limit: 1
        },
        'facebook_ads'
      );

      if (!pageResult || pageResult.length === 0) {
        return error(c, "PAGE_NOT_FOUND", "Page not found or not connected to this organization", 404);
      }

      const page = pageResult[0];

      // If no page access token, fall back to user access token
      let accessToken = page.access_token;
      if (!accessToken) {
        const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
        if (!encryptionKey) {
          return error(c, "CONFIG_ERROR", "Encryption key not configured", 500);
        }
        const { ConnectorService } = await import('../../../services/connectors');
        const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
        accessToken = await connectorService.getAccessToken(connection.id);
      }

      if (!accessToken) {
        return error(c, "NO_TOKEN", "No access token available for this page", 500);
      }

      // Fetch page insights from Facebook Graph API
      // Using metrics that are NOT deprecated as of November 2025
      const metrics = [
        'page_views_total',          // Replaces deprecated page_impressions
        'page_engaged_users',        // Unique users who engaged
        'page_post_engagements',     // Total engagements on posts
        'page_fan_adds',             // New followers
        'page_fan_removes'           // Lost followers
      ].join(',');

      const insightsUrl = new URL(`https://graph.facebook.com/v24.0/${page_id}/insights`);
      insightsUrl.searchParams.set('metric', metrics);
      insightsUrl.searchParams.set('period', period);
      insightsUrl.searchParams.set('access_token', accessToken);
      if (date_preset) {
        insightsUrl.searchParams.set('date_preset', date_preset);
      }

      const response = await fetch(insightsUrl.toString());

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Facebook Page Insights API error:', errorText);

        // Return empty insights rather than failing - page may not have insights yet
        return success(c, {
          page_id,
          page_name: page.page_name,
          period,
          insights: {
            page_views: 0,
            page_engaged_users: 0,
            page_post_engagements: 0,
            page_fan_adds: 0,
            page_fan_removes: 0
          },
          note: "Page insights not available or insufficient data"
        });
      }

      const insightsData = await response.json() as any;

      // Parse insights response into structured format
      const insights: Record<string, number> = {
        page_views: 0,
        page_engaged_users: 0,
        page_post_engagements: 0,
        page_fan_adds: 0,
        page_fan_removes: 0
      };

      if (insightsData.data) {
        for (const metric of insightsData.data) {
          const name = metric.name;
          // Get the most recent value from the values array
          const values = metric.values || [];
          const latestValue = values.length > 0 ? values[values.length - 1].value : 0;

          switch (name) {
            case 'page_views_total':
              insights.page_views = latestValue;
              break;
            case 'page_engaged_users':
              insights.page_engaged_users = latestValue;
              break;
            case 'page_post_engagements':
              insights.page_post_engagements = latestValue;
              break;
            case 'page_fan_adds':
              insights.page_fan_adds = latestValue;
              break;
            case 'page_fan_removes':
              insights.page_fan_removes = latestValue;
              break;
          }
        }
      }

      return success(c, {
        page_id,
        page_name: page.page_name,
        period,
        insights
      });
    } catch (err: any) {
      console.error("Get Facebook page insights error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch page insights: ${err.message}`, 500);
    }
  }
}
