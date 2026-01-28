/**
 * Facebook Ads Analytics Endpoints
 *
 * Provides clean access to Facebook Ads data from D1 ANALYTICS_DB
 * All endpoints use auth + requireOrg middleware for access control
 *
 * Uses D1 ANALYTICS_DB for all data queries
 */

import { OpenAPIRoute, contentJson } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { getSecret } from "../../../utils/secrets";
import { AGE_LIMITS, BUDGET_LIMITS } from "../../../constants/facebook";
import { D1AnalyticsService } from "../../../services/d1-analytics";

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

    // Default date range: last 30 days if not provided
    const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
    const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    console.log('[Facebook Campaigns] Using D1 ANALYTICS_DB');
    try {
      const d1Analytics = new D1AnalyticsService(c.env.ANALYTICS_DB);
      const campaigns = await d1Analytics.getFacebookCampaignsWithMetrics(
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
      const results = campaigns.map(camp => ({
        campaign_id: camp.campaign_id,
        campaign_name: camp.campaign_name,
        status: camp.status,
        last_updated: new Date().toISOString(),
        metrics: {
          impressions: camp.metrics.impressions,
          clicks: camp.metrics.clicks,
          spend: camp.metrics.spend,
          conversions: camp.metrics.conversions,
          revenue: camp.metrics.revenue
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

      console.log(`[Facebook Campaigns] D1 returned ${results.length} campaigns`);
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
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    // Default date range: last 30 days if not provided
    const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
    const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    try {
      // Query ad sets from unified ad_groups table with metrics
      // Facebook's "ad_sets" map to "ad_groups" in unified tables
      let sql = `
        SELECT
          ag.id,
          ag.ad_group_id as ad_set_id,
          ag.ad_group_name as ad_set_name,
          ag.ad_group_status as ad_set_status,
          ag.campaign_id,
          ag.platform_fields,
          ag.updated_at,
          COALESCE(SUM(m.impressions), 0) as impressions,
          COALESCE(SUM(m.clicks), 0) as clicks,
          COALESCE(SUM(m.spend_cents), 0) as spend_cents,
          COALESCE(SUM(m.conversions), 0) as conversions
        FROM ad_groups ag
        LEFT JOIN ad_metrics m
          ON ag.id = m.entity_ref
          AND m.entity_type = 'ad_group'
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        WHERE ag.organization_id = ? AND ag.platform = 'facebook'
      `;
      const params: any[] = [startDate, endDate, orgId];

      if (query.query.campaign_id) {
        sql += ` AND ag.campaign_id = ?`;
        params.push(query.query.campaign_id);
      }

      if (query.query.status) {
        // Map frontend status to unified status
        const statusMap: Record<string, string> = { 'ACTIVE': 'active', 'PAUSED': 'paused', 'DELETED': 'deleted', 'ARCHIVED': 'archived' };
        sql += ` AND ag.ad_group_status = ?`;
        params.push(statusMap[query.query.status] || query.query.status.toLowerCase());
      }

      sql += ` GROUP BY ag.id ORDER BY spend_cents DESC LIMIT ? OFFSET ?`;
      params.push(query.query.limit, query.query.offset);

      const result = await c.env.ANALYTICS_DB.prepare(sql).bind(...params).all<any>();
      const adSets = result.results || [];

      return success(c, {
        ad_sets: adSets.map((row: any) => {
          const pf = row.platform_fields ? JSON.parse(row.platform_fields) : {};
          const dailyBudgetCents = pf.daily_budget ? Math.round(parseFloat(pf.daily_budget) * 100) : null;
          const lifetimeBudgetCents = pf.lifetime_budget ? Math.round(parseFloat(pf.lifetime_budget) * 100) : null;
          return {
            ad_set_id: row.ad_set_id,
            ad_set_name: row.ad_set_name,
            ad_set_status: (row.ad_set_status || '').toUpperCase(),
            status: (row.ad_set_status || '').toUpperCase(),
            campaign_id: row.campaign_id,
            daily_budget_cents: dailyBudgetCents,
            daily_budget: dailyBudgetCents,
            lifetime_budget_cents: lifetimeBudgetCents,
            targeting: pf.targeting || null,
            updated_at: row.updated_at,
            // Include flattened metrics
            impressions: row.impressions || 0,
            clicks: row.clicks || 0,
            spend: (row.spend_cents || 0) / 100,
            spend_cents: row.spend_cents || 0,
            conversions: row.conversions || 0,
            ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
          };
        }),
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
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    try {
      // Query creatives from unified ads table
      // creative_id is stored in platform_fields JSON, not as a top-level column
      const sql = `
        SELECT ad_id, ad_name, platform_fields, updated_at
        FROM ads
        WHERE organization_id = ? AND platform = 'facebook'
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `;
      const result = await c.env.ANALYTICS_DB.prepare(sql)
        .bind(orgId, query.query.limit, query.query.offset)
        .all<any>();

      const creatives = (result.results || []).map((ad: any) => {
        const pf = ad.platform_fields ? JSON.parse(ad.platform_fields) : {};
        return {
          ad_id: ad.ad_id,
          ad_name: ad.ad_name,
          creative_id: pf.creative_id || null,
          updated_at: ad.updated_at
        };
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
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    // Default date range: last 30 days if not provided
    const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
    const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    try {
      // Query ads from unified ads table with metrics
      // creative_id is in platform_fields JSON, not a top-level column
      let sql = `
        SELECT
          a.id,
          a.ad_id,
          a.ad_name,
          a.ad_status,
          a.campaign_id,
          a.ad_group_id as ad_set_id,
          a.platform_fields,
          a.updated_at,
          COALESCE(SUM(m.impressions), 0) as impressions,
          COALESCE(SUM(m.clicks), 0) as clicks,
          COALESCE(SUM(m.spend_cents), 0) as spend_cents,
          COALESCE(SUM(m.conversions), 0) as conversions
        FROM ads a
        LEFT JOIN ad_metrics m
          ON a.id = m.entity_ref
          AND m.entity_type = 'ad'
          AND m.metric_date >= ?
          AND m.metric_date <= ?
        WHERE a.organization_id = ? AND a.platform = 'facebook'
      `;
      const params: any[] = [startDate, endDate, orgId];

      if (query.query.campaign_id) {
        sql += ` AND a.campaign_id = ?`;
        params.push(query.query.campaign_id);
      }

      if (query.query.ad_set_id) {
        // In unified tables, ad_set_id is stored as ad_group_id
        sql += ` AND a.ad_group_id = ?`;
        params.push(query.query.ad_set_id);
      }

      if (query.query.status) {
        // Map frontend status to unified status
        const statusMap: Record<string, string> = { 'ACTIVE': 'active', 'PAUSED': 'paused', 'DELETED': 'deleted', 'ARCHIVED': 'archived' };
        sql += ` AND a.ad_status = ?`;
        params.push(statusMap[query.query.status] || query.query.status.toLowerCase());
      }

      sql += ` GROUP BY a.id ORDER BY spend_cents DESC LIMIT ? OFFSET ?`;
      params.push(query.query.limit, query.query.offset);

      const result = await c.env.ANALYTICS_DB.prepare(sql).bind(...params).all<any>();
      const ads = result.results || [];

      return success(c, {
        ads: ads.map((ad: any) => {
          const pf = ad.platform_fields ? JSON.parse(ad.platform_fields) : {};
          return {
            ad_id: ad.ad_id,
            ad_name: ad.ad_name,
            ad_status: (ad.ad_status || '').toUpperCase(),
            status: (ad.ad_status || '').toUpperCase(),
            campaign_id: ad.campaign_id,
            ad_set_id: ad.ad_set_id,
            creative_id: pf.creative_id || null,
            updated_at: ad.updated_at,
            // Include flattened metrics
            impressions: ad.impressions || 0,
            clicks: ad.clicks || 0,
            spend: (ad.spend_cents || 0) / 100,
            spend_cents: ad.spend_cents || 0,
            conversions: ad.conversions || 0,
            ctr: ad.impressions > 0 ? (ad.clicks / ad.impressions) * 100 : 0,
          };
        }),
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
    const orgId = c.get("org_id" as any) as string;
    const query = await this.getValidatedData<typeof this.schema>();

    if (!c.env.ANALYTICS_DB) {
      return error(c, "CONFIGURATION_ERROR", "ANALYTICS_DB not configured", 500);
    }

    const { start_date, end_date, level, limit, offset } = query.query;

    try {
      // Use unified tables with platform filter
      // Map Facebook's "ad_set" level to unified "ad_group" entity type
      const entityTypeMap: Record<string, string> = {
        campaign: 'campaign',
        ad_set: 'ad_group',  // Facebook ad_sets are unified ad_groups
        ad: 'ad'
      };
      const entityType = entityTypeMap[level];

      // Entity table mapping for unified tables
      const entityTableMap: Record<string, { table: string; nameColumn: string }> = {
        campaign: { table: 'ad_campaigns', nameColumn: 'campaign_name' },
        ad_set: { table: 'ad_groups', nameColumn: 'ad_group_name' },
        ad: { table: 'ads', nameColumn: 'ad_name' }
      };
      const entityInfo = entityTableMap[level];

      let sql = `
        SELECT m.metric_date, m.entity_ref,
               m.impressions, m.clicks, m.spend_cents, m.conversions,
               e.${entityInfo.nameColumn} as entity_name
        FROM ad_metrics m
        LEFT JOIN ${entityInfo.table} e ON m.entity_ref = e.id
        WHERE m.organization_id = ?
          AND m.platform = 'facebook'
          AND m.entity_type = ?
          AND m.metric_date >= ? AND m.metric_date <= ?
      `;
      const params: any[] = [orgId, entityType, start_date, end_date];

      // Add entity filters via joined entity table
      if (query.query.campaign_id) {
        sql += ` AND e.campaign_id = ?`;
        params.push(query.query.campaign_id);
      }
      if (level === 'ad_set' && query.query.ad_set_id) {
        // Filter by ad_group_id (unified equivalent of ad_set_id)
        sql += ` AND e.ad_group_id = ?`;
        params.push(query.query.ad_set_id);
      }
      if (level === 'ad' && query.query.ad_id) {
        sql += ` AND e.ad_id = ?`;
        params.push(query.query.ad_id);
      }

      sql += ` ORDER BY metric_date DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const result = await c.env.ANALYTICS_DB.prepare(sql).bind(...params).all<any>();
      const metrics = result.results || [];

      // Calculate summary
      const summary = metrics.reduce((acc: any, m: any) => ({
        total_impressions: acc.total_impressions + (m.impressions || 0),
        total_clicks: acc.total_clicks + (m.clicks || 0),
        total_spend_cents: acc.total_spend_cents + (m.spend_cents || 0),
        total_conversions: acc.total_conversions + (m.conversions || 0)
      }), {
        total_impressions: 0,
        total_clicks: 0,
        total_spend_cents: 0,
        total_conversions: 0
      });

      return success(c, {
        metrics: metrics.map((m: any) => ({
          metric_date: m.metric_date,
          campaign_ref: m.entity_ref,  // Keep as campaign_ref for frontend compatibility
          entity_ref: m.entity_ref,
          entity_name: m.entity_name || 'Unknown',
          impressions: m.impressions || 0,
          clicks: m.clicks || 0,
          spend_cents: m.spend_cents || 0,
          conversions: m.conversions || 0
        })),
        summary: {
          ...summary,
          total_spend: summary.total_spend_cents / 100,
          ctr: summary.total_impressions > 0 ? (summary.total_clicks / summary.total_impressions) * 100 : 0
        },
        total: metrics.length,
        date_range: { start: start_date, end: end_date },
        level
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
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { campaign_id } = data.params;
    const { status } = data.body;

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
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_set_id } = data.params;
    const { status } = data.body;

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
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_id } = data.params;
    const { status } = data.body;

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
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { campaign_id } = data.params;
    const budget = data.body;

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
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_set_id } = data.params;
    const budget = data.body;

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
    const orgId = c.get("org_id" as any) as string;
    const data = await this.getValidatedData<typeof this.schema>();
    const { ad_set_id } = data.params;
    const { targeting, placement_soft_opt_out } = data.body;

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
 * Retrieves Facebook Pages connected to the user's account from D1.
 * Note: Pages table may not exist yet in D1 - returns empty if not found.
 */
export class GetFacebookPages extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Pages"],
    summary: "Get connected Facebook Pages",
    description: "Retrieves Facebook Pages connected via OAuth from D1.",
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

    // Check if org has an active Facebook connection and get its account_id
    const connection = await c.env.DB.prepare(`
      SELECT account_id FROM platform_connections
      WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
      LIMIT 1
    `).bind(orgId).first<{ account_id: string }>();

    if (!connection) {
      return success(c, {
        pages: [],
        total: 0,
        message: "No active Facebook connection found"
      });
    }

    if (!c.env.ANALYTICS_DB) {
      return success(c, {
        pages: [],
        total: 0,
        message: "ANALYTICS_DB not configured"
      });
    }

    try {
      // Query pages from D1, filtered by both organization_id AND account_id
      // This ensures we only show pages synced for the specific ad account
      const result = await c.env.ANALYTICS_DB.prepare(`
        SELECT page_id, page_name, category, fan_count, access_token
        FROM facebook_pages
        WHERE organization_id = ? AND account_id = ?
        ORDER BY fan_count DESC
        LIMIT ?
      `).bind(orgId, connection.account_id, query.query.limit).all<any>();

      const pages = (result.results || []).map((p: any) => ({
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
      // If facebook_pages table doesn't exist, return empty
      if (err.message?.includes('no such table')) {
        return success(c, {
          pages: [],
          total: 0,
          note: "Facebook pages not yet synced to D1"
        });
      }
      console.error("Get Facebook pages error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch pages: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/pages/:page_id/insights
 *
 * Retrieves insights for a specific Facebook Page via Graph API.
 */
export class GetFacebookPageInsights extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Pages"],
    summary: "Get Facebook Page insights",
    description: "Retrieves engagement insights for a connected Facebook Page via Graph API.",
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
        description: "Facebook Page insights data"
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

    try {
      // Try to get page-specific access token from D1
      let accessToken: string | null = null;
      let pageName = page_id;

      if (c.env.ANALYTICS_DB) {
        try {
          const pageResult = await c.env.ANALYTICS_DB.prepare(`
            SELECT page_name, access_token
            FROM facebook_pages
            WHERE organization_id = ? AND page_id = ?
            LIMIT 1
          `).bind(orgId, page_id).first<{ page_name: string; access_token: string }>();

          if (pageResult) {
            pageName = pageResult.page_name;
            accessToken = pageResult.access_token;
          }
        } catch {
          // facebook_pages table might not exist yet
        }
      }

      // Fall back to user access token if no page token
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
      const metrics = [
        'page_views_total',
        'page_engaged_users',
        'page_post_engagements',
        'page_fan_adds',
        'page_fan_removes'
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
        // Return empty insights rather than failing
        return success(c, {
          page_id,
          page_name: pageName,
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

      // Parse insights response
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
        page_name: pageName,
        period,
        insights
      });
    } catch (err: any) {
      console.error("Get Facebook page insights error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch page insights: ${err.message}`, 500);
    }
  }
}

/**
 * GET /v1/analytics/facebook/audience-insights
 *
 * Returns ad performance breakdowns by demographics, platforms, placements, and devices.
 * This endpoint uses the read_insights permission to fetch breakdown data from Facebook Marketing API.
 */
export class GetFacebookAudienceInsights extends OpenAPIRoute {
  schema = {
    tags: ["Facebook Ads"],
    summary: "Get Facebook audience insights with breakdowns",
    description: "Retrieve ad performance breakdowns by age, gender, platform, placement, and device. Requires read_insights permission.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (YYYY-MM-DD)")
      })
    },
    responses: {
      "200": {
        description: "Audience insights breakdown data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                by_age: z.array(z.any()),
                by_gender: z.array(z.any()),
                by_platform: z.array(z.any()),
                by_placement: z.array(z.any()),
                by_device: z.array(z.any()),
                summary: z.object({
                  total_spend_cents: z.number(),
                  total_impressions: z.number(),
                  total_conversions: z.number(),
                  best_performing_segment: z.string(),
                  recommendation: z.string()
                }),
                date_range: z.object({
                  start_date: z.string(),
                  end_date: z.string()
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
    const query = await this.getValidatedData<typeof this.schema>();

    try {
      // Get Facebook connection for this org
      const connection = await c.env.DB.prepare(`
        SELECT id, account_id FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string; account_id: string }>();

      if (!connection) {
        return success(c, {
          by_age: [],
          by_gender: [],
          by_platform: [],
          by_placement: [],
          by_device: [],
          summary: {
            total_spend_cents: 0,
            total_impressions: 0,
            total_conversions: 0,
            best_performing_segment: "N/A",
            recommendation: "Connect a Facebook Ads account to see audience insights"
          },
          date_range: {
            start_date: query.query.start_date || "",
            end_date: query.query.end_date || ""
          }
        });
      }

      // Get decrypted access token
      const encryptionKey = await getSecret(c.env.ENCRYPTION_KEY);
      const { ConnectorService } = await import('../../../services/connectors');
      const connectorService = await ConnectorService.create(c.env.DB, encryptionKey);
      const accessToken = await connectorService.getAccessToken(connection.id);

      if (!accessToken) {
        return error(c, "TOKEN_ERROR", "Facebook access token not available", 401);
      }

      // Default date range: last 30 days
      const endDate = query.query.end_date || new Date().toISOString().split('T')[0];
      const startDate = query.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const accountId = connection.account_id.startsWith('act_')
        ? connection.account_id
        : `act_${connection.account_id}`;

      // Fetch insights with different breakdowns in parallel
      const baseUrl = `https://graph.facebook.com/v24.0/${accountId}/insights`;
      const baseParams = {
        access_token: accessToken,
        time_range: JSON.stringify({ since: startDate, until: endDate }),
        fields: 'spend,impressions,clicks,reach,actions',
        level: 'account'
      };

      const breakdowns = [
        { name: 'age', breakdown: 'age' },
        { name: 'gender', breakdown: 'gender' },
        { name: 'platform', breakdown: 'publisher_platform' },
        { name: 'placement', breakdown: 'platform_position' },
        { name: 'device', breakdown: 'impression_device' }
      ];

      const results: Record<string, any[]> = {
        by_age: [],
        by_gender: [],
        by_platform: [],
        by_placement: [],
        by_device: []
      };

      let totalSpendCents = 0;
      let totalImpressions = 0;
      let totalConversions = 0;

      // Fetch each breakdown
      for (const { name, breakdown } of breakdowns) {
        try {
          const url = new URL(baseUrl);
          Object.entries(baseParams).forEach(([k, v]) => url.searchParams.set(k, v));
          url.searchParams.set('breakdowns', breakdown);

          const response = await fetch(url.toString(), {
            signal: AbortSignal.timeout(15000)
          });

          if (response.ok) {
            const data = await response.json() as any;
            const entries = data.data || [];

            results[`by_${name}`] = entries.map((entry: any) => {
              const spend = parseFloat(entry.spend || '0');
              const spendCents = Math.round(spend * 100);
              const impressions = parseInt(entry.impressions || '0');
              const clicks = parseInt(entry.clicks || '0');
              const reach = parseInt(entry.reach || '0');

              // Extract conversions from actions
              let conversions = 0;
              if (entry.actions) {
                const purchaseAction = entry.actions.find((a: any) =>
                  a.action_type === 'purchase' || a.action_type === 'omni_purchase'
                );
                conversions = purchaseAction ? parseInt(purchaseAction.value || '0') : 0;
              }

              // Calculate derived metrics
              const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
              const cpaCents = conversions > 0 ? Math.round(spendCents / conversions) : 0;
              const roas = spendCents > 0 && conversions > 0 ? (conversions * 5000) / spendCents : 0; // Assume $50 AOV

              // Track totals from first breakdown (age) to avoid double counting
              if (name === 'age') {
                totalSpendCents += spendCents;
                totalImpressions += impressions;
                totalConversions += conversions;
              }

              // Get dimension value based on breakdown type
              let dimensionValue = entry[breakdown] || 'Unknown';

              return {
                dimension_value: dimensionValue,
                spend_cents: spendCents,
                impressions,
                clicks,
                ctr: Math.round(ctr * 100) / 100,
                conversions,
                cpa_cents: cpaCents,
                roas: Math.round(roas * 100) / 100,
                percentage_of_spend: 0 // Will calculate after
              };
            });
          }
        } catch (breakdownError) {
          console.error(`Failed to fetch ${name} breakdown:`, breakdownError);
          // Continue with other breakdowns
        }
      }

      // Calculate percentage of spend for each breakdown
      for (const key of Object.keys(results)) {
        const entries = results[key];
        const totalForBreakdown = entries.reduce((sum: number, e: any) => sum + e.spend_cents, 0);

        for (const entry of entries) {
          entry.percentage_of_spend = totalForBreakdown > 0
            ? Math.round((entry.spend_cents / totalForBreakdown) * 10000) / 100
            : 0;
        }

        // Sort by spend descending
        results[key] = entries.sort((a: any, b: any) => b.spend_cents - a.spend_cents);
      }

      // Generate recommendation based on best performing segment
      let bestSegment = "N/A";
      let recommendation = "Not enough data to generate insights";

      if (results.by_age.length > 0 && results.by_gender.length > 0) {
        // Find best CPA segment
        const allSegments = [
          ...results.by_age.filter((e: any) => e.conversions > 0).map((e: any) => ({ ...e, type: 'age' })),
          ...results.by_gender.filter((e: any) => e.conversions > 0).map((e: any) => ({ ...e, type: 'gender' })),
          ...results.by_platform.filter((e: any) => e.conversions > 0).map((e: any) => ({ ...e, type: 'platform' }))
        ];

        if (allSegments.length > 0) {
          // Sort by CPA (lower is better)
          allSegments.sort((a, b) => a.cpa_cents - b.cpa_cents);
          const best = allSegments[0];
          bestSegment = `${best.dimension_value} (${best.type})`;

          const cpaDollars = (best.cpa_cents / 100).toFixed(2);
          recommendation = `Best performing: ${best.dimension_value} with $${cpaDollars} CPA. Consider increasing budget allocation to this segment.`;
        }
      }

      return success(c, {
        by_age: results.by_age,
        by_gender: results.by_gender,
        by_platform: results.by_platform,
        by_placement: results.by_placement,
        by_device: results.by_device,
        summary: {
          total_spend_cents: totalSpendCents,
          total_impressions: totalImpressions,
          total_conversions: totalConversions,
          best_performing_segment: bestSegment,
          recommendation
        },
        date_range: {
          start_date: startDate,
          end_date: endDate
        }
      });
    } catch (err: any) {
      console.error("Get Facebook audience insights error:", err);
      return error(c, "QUERY_FAILED", `Failed to fetch audience insights: ${err.message}`, 500);
    }
  }
}
