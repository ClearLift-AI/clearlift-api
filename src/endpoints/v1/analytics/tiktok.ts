/**
 * TikTok Ads Analytics Endpoints
 *
 * Provides clean access to TikTok Ads data from Supabase tiktok_ads schema
 * All endpoints use auth + requireOrg middleware for access control
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { TikTokAdsSupabaseAdapter, DateRange } from "../../../adapters/platforms/tiktok-supabase";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { BUDGET_LIMITS, AGE_GROUPS, STATUS } from "../../../constants/tiktok";
import { TikTokAdsOAuthProvider, TikTokTargeting } from "../../../services/oauth/tiktok";
import { D1AnalyticsService } from "../../../services/d1-analytics";

/**
 * Check if D1 analytics should be used
 */
function useD1Analytics(env: any): boolean {
  return env.USE_D1_ANALYTICS === 'true' && !!env.ANALYTICS_DB;
}

/**
 * GET /v1/analytics/tiktok/campaigns
 */
export class GetTikTokCampaigns extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Get TikTok Ads campaigns with metrics",
    description: "Retrieve TikTok Ads campaigns with aggregated metrics for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (YYYY-MM-DD) for metrics aggregation"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (YYYY-MM-DD) for metrics aggregation"),
        status: z.enum(['ACTIVE', 'PAUSED', 'DELETED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "TikTok Ads campaigns data with metrics",
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

    // Check if org has an active TikTok connection
    // Prevents returning orphaned data for orgs without active connections
    const hasConnection = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections
      WHERE organization_id = ? AND platform = 'tiktok' AND is_active = 1
      LIMIT 1
    `).bind(orgId).first();

    if (!hasConnection) {
      return success(c, {
        platform: 'tiktok',
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

    // Default date range: last 30 days if not provided
    const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
    const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Try D1 first if enabled
    if (useD1Analytics(c.env)) {
      console.log('[TikTok Campaigns] Using D1 ANALYTICS_DB');
      try {
        const d1Analytics = new D1AnalyticsService(c.env.ANALYTICS_DB);
        const campaigns = await d1Analytics.getTikTokCampaignsWithMetrics(
          orgId,
          startDate,
          endDate,
          {
            status: query.query.status,
            limit: query.query.limit,
            offset: query.query.offset
          }
        );

        // Transform to frontend expected format
        const results = campaigns.map(c => ({
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          status: c.status,
          last_updated: new Date().toISOString(),
          metrics: {
            impressions: c.metrics.impressions,
            clicks: c.metrics.clicks,
            spend: c.metrics.spend, // Already in dollars from D1 service
            conversions: c.metrics.conversions,
            revenue: c.metrics.revenue
          }
        }));

        // Calculate summary from results
        const summary = results.reduce(
          (acc, campaign) => ({
            total_impressions: acc.total_impressions + campaign.metrics.impressions,
            total_clicks: acc.total_clicks + campaign.metrics.clicks,
            total_spend: acc.total_spend + campaign.metrics.spend,
            total_conversions: acc.total_conversions + campaign.metrics.conversions,
            average_ctr: 0
          }),
          { total_impressions: 0, total_clicks: 0, total_spend: 0, total_conversions: 0, average_ctr: 0 }
        );

        if (summary.total_impressions > 0) {
          summary.average_ctr = (summary.total_clicks / summary.total_impressions) * 100;
        }

        console.log(`[TikTok Campaigns] D1 returned ${results.length} campaigns`);
        return success(c, {
          platform: 'tiktok',
          results,
          summary
        });
      } catch (d1Error) {
        console.error('[TikTok Campaigns] D1 query failed, falling back to Supabase:', d1Error);
      }
    }

    // Fallback to Supabase
    // Initialize Supabase client
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }

    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    const adapter = new TikTokAdsSupabaseAdapter(supabase);
    const dateRange: DateRange = { start: startDate, end: endDate };

    try {
      console.log('[TikTok Campaigns] Using Supabase fallback, date range:', { startDate, endDate });

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

      console.log('[TikTok Campaigns] Campaigns with metrics returned:', campaignsWithMetrics.length);

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
          conversions: c.metrics.conversions || 0,
          revenue: 0 // Revenue comes from Stripe, not ad platforms
        }
      }));

      // Debug: Log first campaign's metrics to verify date filtering
      if (results.length > 0) {
        console.log('[TikTok Campaigns] Sample campaign metrics:', {
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
        platform: 'tiktok',
        results,
        summary
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

    const adapter = new TikTokAdsSupabaseAdapter(supabase);

    try {
      const adGroups = await adapter.getAdGroups(orgId, {
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

    const adapter = new TikTokAdsSupabaseAdapter(supabase);

    try {
      const ads = await adapter.getAds(orgId, {
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
    // Use resolved org_id from requireOrg middleware (handles both UUID and slug)
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    // Check if org has an active TikTok connection first
    // Prevents timeout when querying Supabase for orgs without TikTok
    const hasConnection = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections
      WHERE organization_id = ? AND platform = 'tiktok' AND is_active = 1
      LIMIT 1
    `).bind(orgId).first();

    if (!hasConnection) {
      return success(c, {
        metrics: [],
        summary: {
          total_impressions: 0,
          total_clicks: 0,
          total_spend_cents: 0,
          total_conversions: 0
        },
        total: 0,
        date_range: {
          start: query.query.start_date,
          end: query.query.end_date
        },
        level: query.query.level
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
        metrics = await adapter.getCampaignDailyMetrics(orgId, dateRange, {
          campaignId: query.query.campaign_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(orgId, dateRange, 'campaign');
      } else if (query.query.level === 'ad_group') {
        metrics = await adapter.getAdGroupDailyMetrics(orgId, dateRange, {
          adGroupId: query.query.ad_group_id,
          limit: query.query.limit,
          offset: query.query.offset
        });
        summary = await adapter.getMetricsSummary(orgId, dateRange, 'ad_group');
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
      console.error("Get TikTok metrics error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch metrics: ${err.message}`, 500);
    }
  }
}

// ==================== WRITE ENDPOINTS ====================
// These implement the AI_PLAN.md tools: set_active, set_budget, set_audience

/**
 * PATCH /v1/analytics/tiktok/campaigns/:campaign_id/status
 * Implements set_active tool for campaigns
 */
export class UpdateTikTokCampaignStatus extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Update TikTok campaign status",
    description: "Enable or disable a TikTok campaign",
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
          status: z.enum(['ENABLE', 'DISABLE']).describe("New status for the campaign")
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
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { campaign_id } = data.params;
    const { status } = data.body;

    try {
      // Get TikTok connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'tiktok' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active TikTok connection found for this organization", 404);
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

      // Update campaign status via TikTok API
      const appId = await getSecret(c.env.TIKTOK_APP_ID);
      const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "TikTok credentials not configured", 500);
      }
      const tiktokProvider = new TikTokAdsOAuthProvider(appId, appSecret, '');

      await tiktokProvider.updateCampaignStatus(
        accessToken,
        connection.account_id,  // advertiser_id
        campaign_id,
        status
      );

      return success(c, {
        campaign_id,
        status,
        message: `Campaign ${status === 'ENABLE' ? 'enabled' : 'disabled'} successfully`
      });
    } catch (err: any) {
      console.error("Update TikTok campaign status error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update campaign status: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/tiktok/ad-groups/:ad_group_id/status
 * Implements set_active tool for ad groups
 */
export class UpdateTikTokAdGroupStatus extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Update TikTok ad group status",
    description: "Enable or disable a TikTok ad group",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        ad_group_id: z.string()
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      }),
      body: contentJson(
        z.object({
          status: z.enum(['ENABLE', 'DISABLE']).describe("New status for the ad group")
        })
      )
    },
    responses: {
      "200": {
        description: "Ad group status updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_group_id } = data.params;
    const { status } = data.body;

    try {
      // Get TikTok connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'tiktok' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active TikTok connection found for this organization", 404);
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

      // Update ad group status via TikTok API
      const appId = await getSecret(c.env.TIKTOK_APP_ID);
      const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "TikTok credentials not configured", 500);
      }
      const tiktokProvider = new TikTokAdsOAuthProvider(appId, appSecret, '');

      await tiktokProvider.updateAdGroupStatus(
        accessToken,
        connection.account_id,  // advertiser_id
        ad_group_id,
        status
      );

      return success(c, {
        ad_group_id,
        status,
        message: `Ad group ${status === 'ENABLE' ? 'enabled' : 'disabled'} successfully`
      });
    } catch (err: any) {
      console.error("Update TikTok ad group status error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad group status: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/tiktok/campaigns/:campaign_id/budget
 * Implements set_budget tool for campaigns
 */
export class UpdateTikTokCampaignBudget extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Update TikTok campaign budget",
    description: "Update the budget for a TikTok campaign",
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
          budget_cents: z.number().min(BUDGET_LIMITS.DAILY_MIN_CENTS)
            .describe(`Budget in cents (minimum $${BUDGET_LIMITS.DAILY_MIN_CENTS / 100})`),
          budget_mode: z.enum(['BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL']).optional()
            .default('BUDGET_MODE_DAY')
            .describe("Budget mode: daily or lifetime")
        })
      )
    },
    responses: {
      "200": {
        description: "Campaign budget updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { campaign_id } = data.params;
    const { budget_cents, budget_mode } = data.body;

    try {
      // Get TikTok connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'tiktok' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active TikTok connection found for this organization", 404);
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

      // Update campaign budget via TikTok API
      const appId = await getSecret(c.env.TIKTOK_APP_ID);
      const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "TikTok credentials not configured", 500);
      }
      const tiktokProvider = new TikTokAdsOAuthProvider(appId, appSecret, '');

      await tiktokProvider.updateCampaignBudget(
        accessToken,
        connection.account_id,  // advertiser_id
        campaign_id,
        budget_cents,
        budget_mode
      );

      return success(c, {
        campaign_id,
        budget_cents,
        budget_mode,
        message: `Campaign budget updated to $${(budget_cents / 100).toFixed(2)} ${budget_mode === 'BUDGET_MODE_DAY' ? 'daily' : 'lifetime'}`
      });
    } catch (err: any) {
      console.error("Update TikTok campaign budget error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update campaign budget: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/tiktok/ad-groups/:ad_group_id/budget
 * Implements set_budget tool for ad groups
 */
export class UpdateTikTokAdGroupBudget extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Update TikTok ad group budget",
    description: "Update the budget for a TikTok ad group",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        ad_group_id: z.string()
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      }),
      body: contentJson(
        z.object({
          budget_cents: z.number().min(BUDGET_LIMITS.DAILY_MIN_CENTS)
            .describe(`Budget in cents (minimum $${BUDGET_LIMITS.DAILY_MIN_CENTS / 100})`),
          budget_mode: z.enum(['BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL']).optional()
            .default('BUDGET_MODE_DAY')
            .describe("Budget mode: daily or lifetime")
        })
      )
    },
    responses: {
      "200": {
        description: "Ad group budget updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_group_id } = data.params;
    const { budget_cents, budget_mode } = data.body;

    try {
      // Get TikTok connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'tiktok' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active TikTok connection found for this organization", 404);
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

      // Update ad group budget via TikTok API
      const appId = await getSecret(c.env.TIKTOK_APP_ID);
      const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "TikTok credentials not configured", 500);
      }
      const tiktokProvider = new TikTokAdsOAuthProvider(appId, appSecret, '');

      await tiktokProvider.updateAdGroupBudget(
        accessToken,
        connection.account_id,  // advertiser_id
        ad_group_id,
        budget_cents,
        budget_mode
      );

      return success(c, {
        ad_group_id,
        budget_cents,
        budget_mode,
        message: `Ad group budget updated to $${(budget_cents / 100).toFixed(2)} ${budget_mode === 'BUDGET_MODE_DAY' ? 'daily' : 'lifetime'}`
      });
    } catch (err: any) {
      console.error("Update TikTok ad group budget error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad group budget: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/tiktok/ad-groups/:ad_group_id/targeting
 * Implements set_audience tool
 */
export class UpdateTikTokAdGroupTargeting extends OpenAPIRoute {
  schema = {
    tags: ["TikTok Ads"],
    summary: "Update TikTok ad group targeting",
    description: "Update the audience targeting for a TikTok ad group",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        ad_group_id: z.string()
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID")
      }),
      body: contentJson(
        z.object({
          age: z.array(z.enum([
            AGE_GROUPS.AGE_13_17,
            AGE_GROUPS.AGE_18_24,
            AGE_GROUPS.AGE_25_34,
            AGE_GROUPS.AGE_35_44,
            AGE_GROUPS.AGE_45_54,
            AGE_GROUPS.AGE_55_PLUS
          ])).optional().describe("Age group targeting"),
          gender: z.enum(['MALE', 'FEMALE', 'UNLIMITED']).optional()
            .describe("Gender targeting"),
          interest_category_ids: z.array(z.string()).optional()
            .describe("Interest category IDs for targeting"),
          location_ids: z.array(z.string()).optional()
            .describe("Location IDs for geo-targeting")
        })
      )
    },
    responses: {
      "200": {
        description: "Ad group targeting updated successfully"
      }
    }
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_group_id } = data.params;
    const targeting: TikTokTargeting = data.body;

    try {
      // Get TikTok connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'tiktok' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active TikTok connection found for this organization", 404);
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

      // Update ad group targeting via TikTok API
      const appId = await getSecret(c.env.TIKTOK_APP_ID);
      const appSecret = await getSecret(c.env.TIKTOK_APP_SECRET);
      if (!appId || !appSecret) {
        return error(c, "CONFIG_ERROR", "TikTok credentials not configured", 500);
      }
      const tiktokProvider = new TikTokAdsOAuthProvider(appId, appSecret, '');

      await tiktokProvider.updateAdGroupTargeting(
        accessToken,
        connection.account_id,  // advertiser_id
        ad_group_id,
        targeting
      );

      return success(c, {
        ad_group_id,
        targeting,
        message: "Ad group targeting updated successfully"
      });
    } catch (err: any) {
      console.error("Update TikTok ad group targeting error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad group targeting: ${err.message}`, 500);
    }
  }
}
