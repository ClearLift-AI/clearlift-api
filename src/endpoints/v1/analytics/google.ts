/**
 * Google Ads Analytics Endpoints
 *
 * Provides clean access to Google Ads data from D1 ANALYTICS_DB
 * All endpoints use auth + requireOrg middleware for access control
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { getSecret } from "../../../utils/secrets";
import { GoogleAdsOAuthProvider } from "../../../services/oauth/google";
import { D1AnalyticsService } from "../../../services/d1-analytics";

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

    // Default date range: last 30 days if not provided
    const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
    const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      console.log('[Google Campaigns] Using D1 ANALYTICS_DB');
      const d1Analytics = new D1AnalyticsService(c.env.ANALYTICS_DB);
      const campaigns = await d1Analytics.getGoogleCampaignsWithMetrics(
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
          spend: c.metrics.spend,
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

      console.log(`[Google Campaigns] D1 returned ${results.length} campaigns`);
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
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Query ad groups from D1
      let sql = `
        SELECT
          ag.ad_group_id,
          ag.ad_group_name,
          ag.campaign_id,
          ag.status,
          c.campaign_name
        FROM google_ad_groups ag
        LEFT JOIN google_campaigns c ON ag.campaign_id = c.campaign_id AND ag.organization_id = c.organization_id
        WHERE ag.organization_id = ?
      `;
      const params: any[] = [orgId];

      if (query.query.campaign_id) {
        sql += ' AND ag.campaign_id = ?';
        params.push(query.query.campaign_id);
      }
      if (query.query.status) {
        sql += ' AND ag.status = ?';
        params.push(query.query.status);
      }

      sql += ' ORDER BY ag.ad_group_name ASC';
      sql += ` LIMIT ${query.query.limit} OFFSET ${query.query.offset}`;

      const result = await c.env.ANALYTICS_DB.prepare(sql).bind(...params).all<any>();
      const adGroups = result.results || [];

      return success(c, {
        ad_groups: adGroups.map((ag: any) => ({
          ad_group_id: ag.ad_group_id,
          ad_group_name: ag.ad_group_name,
          campaign_id: ag.campaign_id,
          campaign_name: ag.campaign_name,
          status: ag.status
        })),
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
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Query ads from D1
      let sql = `
        SELECT
          a.ad_id,
          a.ad_name,
          a.ad_group_id,
          a.campaign_id,
          a.status,
          a.ad_type,
          ag.ad_group_name
        FROM google_ads a
        LEFT JOIN google_ad_groups ag ON a.ad_group_id = ag.ad_group_id AND a.organization_id = ag.organization_id
        WHERE a.organization_id = ?
      `;
      const params: any[] = [orgId];

      if (query.query.campaign_id) {
        sql += ' AND a.campaign_id = ?';
        params.push(query.query.campaign_id);
      }
      if (query.query.ad_group_id) {
        sql += ' AND a.ad_group_id = ?';
        params.push(query.query.ad_group_id);
      }
      if (query.query.status) {
        sql += ' AND a.status = ?';
        params.push(query.query.status);
      }

      sql += ' ORDER BY a.ad_name ASC';
      sql += ` LIMIT ${query.query.limit} OFFSET ${query.query.offset}`;

      const result = await c.env.ANALYTICS_DB.prepare(sql).bind(...params).all<any>();
      const ads = result.results || [];

      return success(c, {
        ads: ads.map((ad: any) => ({
          ad_id: ad.ad_id,
          ad_name: ad.ad_name,
          ad_group_id: ad.ad_group_id,
          ad_group_name: ad.ad_group_name,
          campaign_id: ad.campaign_id,
          status: ad.status,
          ad_type: ad.ad_type
        })),
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
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    const dateRange = {
      start: query.query.start_date,
      end: query.query.end_date
    };

    try {
      // Determine table and ID column based on level
      const tableMap: Record<string, { table: string; idColumn: string; nameColumn: string; filterColumn?: string }> = {
        campaign: {
          table: 'google_campaign_daily_metrics',
          idColumn: 'campaign_ref',
          nameColumn: 'campaign_name',
          filterColumn: 'campaign_ref'
        },
        ad_group: {
          table: 'google_ad_group_daily_metrics',
          idColumn: 'ad_group_ref',
          nameColumn: 'ad_group_name',
          filterColumn: 'ad_group_ref'
        },
        ad: {
          table: 'google_ad_daily_metrics',
          idColumn: 'ad_ref',
          nameColumn: 'ad_name',
          filterColumn: 'ad_ref'
        }
      };

      const tableInfo = tableMap[query.query.level];

      let sql = `
        SELECT
          ${tableInfo.idColumn} as entity_id,
          date,
          impressions,
          clicks,
          spend_cents,
          conversions,
          conversion_value_cents
        FROM ${tableInfo.table}
        WHERE organization_id = ?
        AND date >= ? AND date <= ?
      `;
      const params: any[] = [orgId, dateRange.start, dateRange.end];

      // Add entity-specific filter
      if (query.query.level === 'campaign' && query.query.campaign_id) {
        sql += ` AND ${tableInfo.filterColumn} = ?`;
        params.push(query.query.campaign_id);
      } else if (query.query.level === 'ad_group' && query.query.ad_group_id) {
        sql += ` AND ${tableInfo.filterColumn} = ?`;
        params.push(query.query.ad_group_id);
      } else if (query.query.level === 'ad' && query.query.ad_id) {
        sql += ` AND ${tableInfo.filterColumn} = ?`;
        params.push(query.query.ad_id);
      }

      sql += ' ORDER BY date DESC';
      sql += ` LIMIT ${query.query.limit} OFFSET ${query.query.offset}`;

      const result = await c.env.ANALYTICS_DB.prepare(sql).bind(...params).all<any>();
      const metrics = (result.results || []).map((row: any) => ({
        entity_id: row.entity_id,
        date: row.date,
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
        spend: (row.spend_cents || 0) / 100,
        conversions: row.conversions || 0,
        revenue: (row.conversion_value_cents || 0) / 100
      }));

      // Calculate summary
      const summary = metrics.reduce(
        (acc: any, m: any) => ({
          total_impressions: acc.total_impressions + m.impressions,
          total_clicks: acc.total_clicks + m.clicks,
          total_spend: acc.total_spend + m.spend,
          total_conversions: acc.total_conversions + m.conversions,
          total_revenue: acc.total_revenue + m.revenue
        }),
        { total_impressions: 0, total_clicks: 0, total_spend: 0, total_conversions: 0, total_revenue: 0 }
      );

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
