import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { Session } from "../../../middleware/auth";
import { FacebookAdapter } from "../../../adapters/platforms/facebook";
import { success, error, getDateRange, getPagination } from "../../../utils/response";

/**
 * GET /v1/platform/fb/campaigns - Get Facebook campaigns
 */
export class GetFacebookCampaigns extends OpenAPIRoute {
  public schema = {
    tags: ["Platform - Facebook"],
    summary: "Get Facebook ad campaigns",
    operationId: "get-facebook-campaigns",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
        sort_by: z.enum(["spend", "impressions", "clicks", "conversions"]).optional(),
        order: z.enum(["asc", "desc"]).optional()
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
      "401": { description: "Unauthorized" },
      "403": { description: "No organization selected" }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const dateRange = getDateRange(c);
    const { limit, offset } = getPagination(c);
    const sortBy = c.req.query("sort_by") as string | undefined;
    const order = c.req.query("order") as "asc" | "desc" | undefined;

    // Use SECRET_KEY for server-side access (bypasses RLS)
    // In local dev, this comes from .dev.vars as a string
    // In production, it's from secrets_store_secrets
    const supabaseKey = c.env.SUPABASE_SECRET_KEY;

    const fb = new FacebookAdapter(
      c.env.SUPABASE_URL,
      supabaseKey
    );

    try {
      const campaigns = await fb.getCampaigns(
        orgId,
        dateRange,
        { limit, offset, sort_by: sortBy, order }
      );

      const summary = await fb.getSummary(
        orgId,
        dateRange
      );

      return success(
        c,
        { campaigns, summary },
        { date_range: dateRange }
      );
    } catch (err) {
      console.error("Failed to fetch Facebook campaigns:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch campaign data";
      return error(c, "FETCH_FAILED", errorMessage, 500);
    }
  }
}

/**
 * GET /v1/platform/fb/campaigns/:campaignId - Get specific campaign
 */
export class GetFacebookCampaign extends OpenAPIRoute {
  public schema = {
    tags: ["Platform - Facebook"],
    summary: "Get specific Facebook campaign",
    operationId: "get-facebook-campaign",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        campaignId: z.string()
      }),
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional(),
        end_date: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Facebook campaign details",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                campaign: z.any()
              })
            })
          }
        }
      },
      "404": { description: "Campaign not found" }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    const data = await this.getValidatedData<typeof this.schema>();
    const { campaignId } = data.params;

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const dateRange = getDateRange(c);

    // Use SECRET_KEY for server-side access (bypasses RLS)
    // In local dev, this comes from .dev.vars as a string
    // In production, it's from secrets_store_secrets
    const supabaseKey = c.env.SUPABASE_SECRET_KEY;

    const fb = new FacebookAdapter(
      c.env.SUPABASE_URL,
      supabaseKey
    );

    try {
      const campaign = await fb.getCampaign(
        orgId,
        campaignId,
        dateRange
      );

      if (!campaign) {
        return error(c, "NOT_FOUND", "Campaign not found", 404);
      }

      return success(c, { campaign });
    } catch (err) {
      console.error("Failed to fetch Facebook campaign:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch campaign";
      return error(c, "FETCH_FAILED", errorMessage, 500);
    }
  }
}

/**
 * GET /v1/platform/fb/ads - Get Facebook ads
 */
export class GetFacebookAds extends OpenAPIRoute {
  public schema = {
    tags: ["Platform - Facebook"],
    summary: "Get Facebook ads performance",
    operationId: "get-facebook-ads",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        campaign_id: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional()
      })
    },
    responses: {
      "200": {
        description: "Facebook ads data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                ads: z.array(z.any()),
                total: z.number()
              }),
              meta: z.any()
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const dateRange = getDateRange(c);
    const { limit, offset } = getPagination(c);
    const campaignId = c.req.query("campaign_id");

    // Use SECRET_KEY for server-side access (bypasses RLS)
    // In local dev, this comes from .dev.vars as a string
    // In production, it's from secrets_store_secrets
    const supabaseKey = c.env.SUPABASE_SECRET_KEY;

    const fb = new FacebookAdapter(
      c.env.SUPABASE_URL,
      supabaseKey
    );

    try {
      const ads = await fb.getAds(
        orgId,
        dateRange,
        { campaign_id: campaignId, limit, offset }
      );

      return success(
        c,
        { ads, total: ads.length },
        { date_range: dateRange, limit, offset }
      );
    } catch (err) {
      console.error("Failed to fetch Facebook ads:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch ads data";
      return error(c, "FETCH_FAILED", errorMessage, 500);
    }
  }
}

/**
 * GET /v1/platform/fb/metrics - Get daily metrics
 */
export class GetFacebookMetrics extends OpenAPIRoute {
  public schema = {
    tags: ["Platform - Facebook"],
    summary: "Get Facebook daily metrics",
    operationId: "get-facebook-metrics",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
        campaign_id: z.string().optional(),
        group_by: z.enum(["day", "week", "month"]).optional()
      })
    },
    responses: {
      "200": {
        description: "Facebook metrics time series",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                metrics: z.array(z.any()),
                group_by: z.string()
              })
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");

    if (!orgId) {
      return error(c, "NO_ORGANIZATION", "Organization ID not found in context", 403);
    }

    const dateRange = getDateRange(c);
    const campaignId = c.req.query("campaign_id");
    const groupBy = (c.req.query("group_by") || "day") as "day" | "week" | "month";

    // Use SECRET_KEY for server-side access (bypasses RLS)
    // In local dev, this comes from .dev.vars as a string
    // In production, it's from secrets_store_secrets
    const supabaseKey = c.env.SUPABASE_SECRET_KEY;

    const fb = new FacebookAdapter(
      c.env.SUPABASE_URL,
      supabaseKey
    );

    try {
      const metrics = await fb.getDailyMetrics(
        orgId,
        dateRange,
        { campaign_id: campaignId, group_by: groupBy }
      );

      return success(c, { metrics, group_by: groupBy });
    } catch (err) {
      console.error("Failed to fetch Facebook metrics:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch metrics";
      return error(c, "FETCH_FAILED", errorMessage, 500);
    }
  }
}