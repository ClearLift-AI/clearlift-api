/**
 * Google Ads Analytics Endpoints
 *
 * Provides clean access to Google Ads data from Supabase google_ads schema
 * All endpoints use auth + requireOrg middleware for access control
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { GoogleAdsSupabaseAdapter, DateRange } from "../../../adapters/platforms/google-supabase";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";
import { GoogleAdsOAuthProvider } from "../../../services/oauth/google";

/**
 * GET /v1/analytics/google/campaigns
 */
export class GetGoogleCampaigns extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Get Google Ads campaigns with metrics",
    description: "Retrieve Google Ads campaigns with aggregated metrics for an organization",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (YYYY-MM-DD) for metrics aggregation"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (YYYY-MM-DD) for metrics aggregation"),
        status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).optional(),
        limit: z.coerce.number().min(1).max(1000).optional().default(100),
        offset: z.coerce.number().min(0).optional().default(0)
      })
    },
    responses: {
      "200": {
        description: "Google Ads campaigns data with metrics",
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

    // Check if org has an active Google connection
    // Prevents returning orphaned data for orgs without active connections
    const hasConnection = await c.env.DB.prepare(`
      SELECT 1 FROM platform_connections
      WHERE organization_id = ? AND platform = 'google' AND is_active = 1
      LIMIT 1
    `).bind(orgId).first();

    if (!hasConnection) {
      return success(c, {
        platform: 'google',
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
      serviceKey: supabaseKey
    });

    const adapter = new GoogleAdsSupabaseAdapter(supabase);

    try {
      // Default date range: last 30 days if not provided
      const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
      const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const dateRange: DateRange = { start: startDate, end: endDate };

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

      // Transform to frontend expected format
      const results = campaignsWithMetrics.map(c => ({
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        status: c.campaign_status,
        metrics: {
          impressions: c.metrics.impressions,
          clicks: c.metrics.clicks,
          spend: c.metrics.spend_cents / 100, // Convert cents to dollars for frontend
          conversions: c.metrics.conversions,
          revenue: c.metrics.conversion_value_cents / 100 // Google has conversion value
        }
      }));

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
        platform: 'google',
        results,
        summary
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
      serviceKey: supabaseKey
    });

    const adapter = new GoogleAdsSupabaseAdapter(supabase);

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
      serviceKey: supabaseKey
    });

    const adapter = new GoogleAdsSupabaseAdapter(supabase);

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
      console.error("Get Google metrics error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch metrics: ${err.message}`, 500);
    }
  }
}

// ==================== WRITE ENDPOINTS ====================
// These implement the AI_PLAN.md tools: set_active, set_budget

/**
 * PATCH /v1/analytics/google/campaigns/:campaign_id/status
 * Implements set_active tool for campaigns
 */
export class UpdateGoogleCampaignStatus extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Update Google campaign status",
    description: "Enable, pause, or remove a Google campaign",
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
          status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).describe("New status for the campaign")
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
      // Get Google connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'google' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Google connection found for this organization", 404);
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

      // Get credentials
      const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
      const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
      const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (!clientId || !clientSecret) {
        return error(c, "CONFIG_ERROR", "Google credentials not configured", 500);
      }
      if (!developerToken) {
        return error(c, "CONFIG_ERROR", "Google Ads developer token not configured", 500);
      }

      const googleProvider = new GoogleAdsOAuthProvider(clientId, clientSecret, '');

      await googleProvider.updateCampaignStatus(
        accessToken,
        developerToken,
        connection.account_id,  // customer_id
        campaign_id,
        status
      );

      return success(c, {
        campaign_id,
        status,
        message: `Campaign ${status === 'ENABLED' ? 'enabled' : status === 'PAUSED' ? 'paused' : 'removed'} successfully`
      });
    } catch (err: any) {
      console.error("Update Google campaign status error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update campaign status: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/google/ad-groups/:ad_group_id/status
 * Implements set_active tool for ad groups
 */
export class UpdateGoogleAdGroupStatus extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Update Google ad group status",
    description: "Enable, pause, or remove a Google ad group",
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
          status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).describe("New status for the ad group")
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
      // Get Google connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'google' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Google connection found for this organization", 404);
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

      // Get credentials
      const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
      const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
      const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (!clientId || !clientSecret) {
        return error(c, "CONFIG_ERROR", "Google credentials not configured", 500);
      }
      if (!developerToken) {
        return error(c, "CONFIG_ERROR", "Google Ads developer token not configured", 500);
      }

      const googleProvider = new GoogleAdsOAuthProvider(clientId, clientSecret, '');

      await googleProvider.updateAdGroupStatus(
        accessToken,
        developerToken,
        connection.account_id,  // customer_id
        ad_group_id,
        status
      );

      return success(c, {
        ad_group_id,
        status,
        message: `Ad group ${status === 'ENABLED' ? 'enabled' : status === 'PAUSED' ? 'paused' : 'removed'} successfully`
      });
    } catch (err: any) {
      console.error("Update Google ad group status error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update ad group status: ${err.message}`, 500);
    }
  }
}

/**
 * PATCH /v1/analytics/google/campaigns/:campaign_id/budget
 * Implements set_budget tool for campaigns
 */
export class UpdateGoogleCampaignBudget extends OpenAPIRoute {
  schema = {
    tags: ["Google Ads"],
    summary: "Update Google campaign budget",
    description: "Update the daily budget for a Google campaign",
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
          budget_cents: z.number().min(100)
            .describe("Daily budget in cents (minimum $1.00)")
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
    const { budget_cents } = data.body;

    try {
      // Get Google connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id
        FROM platform_connections
        WHERE organization_id = ? AND platform = 'google' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return error(c, "NO_CONNECTION", "No active Google connection found for this organization", 404);
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

      // Get credentials
      const clientId = await getSecret(c.env.GOOGLE_CLIENT_ID);
      const clientSecret = await getSecret(c.env.GOOGLE_CLIENT_SECRET);
      const developerToken = await getSecret(c.env.GOOGLE_ADS_DEVELOPER_TOKEN);
      if (!clientId || !clientSecret) {
        return error(c, "CONFIG_ERROR", "Google credentials not configured", 500);
      }
      if (!developerToken) {
        return error(c, "CONFIG_ERROR", "Google Ads developer token not configured", 500);
      }

      const googleProvider = new GoogleAdsOAuthProvider(clientId, clientSecret, '');

      // Google Ads uses micros (1 dollar = 1,000,000 micros), convert from cents
      const budgetMicros = budget_cents * 10000;

      await googleProvider.updateCampaignBudget(
        accessToken,
        developerToken,
        connection.account_id,  // customer_id
        campaign_id,
        budgetMicros
      );

      return success(c, {
        campaign_id,
        budget_cents,
        message: `Campaign budget updated to $${(budget_cents / 100).toFixed(2)} daily`
      });
    } catch (err: any) {
      console.error("Update Google campaign budget error:", err);
      return error(c, "UPDATE_FAILED", `Failed to update campaign budget: ${err.message}`, 500);
    }
  }
}
