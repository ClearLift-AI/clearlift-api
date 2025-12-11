/**
 * Click ID Attribution Endpoint
 *
 * Fetches conversion data grouped by click ID platform (Google/Meta/TikTok)
 * from the events.conversion_attribution table.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { SupabaseClient } from "../../../services/supabase";
import { getSecret } from "../../../utils/secrets";

const PlatformAttributionSchema = z.object({
  click_id_type: z.enum(["gclid", "fbclid", "ttclid"]),
  platform: z.enum(["google", "meta", "tiktok"]),
  conversions: z.number(),
  revenue_cents: z.number(),
  avg_order_value_cents: z.number(),
  unique_users: z.number(),
  avg_confidence_score: z.number().nullable(),
});

const ClickAttributionSummarySchema = z.object({
  total_attributed_conversions: z.number(),
  total_attributed_revenue_cents: z.number(),
  unattributed_conversions: z.number(),
  unattributed_revenue_cents: z.number(),
  attribution_rate: z.number(),
});

/**
 * GET /v1/analytics/click-attribution
 *
 * Fetches conversion data grouped by click ID type from Supabase events.conversion_attribution table.
 */
export class GetClickAttribution extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get click ID attribution breakdown",
    description: `
Fetches conversion data grouped by click ID platform:
- Google (gclid): Conversions attributed to Google Ads clicks
- Meta (fbclid): Conversions attributed to Meta/Facebook Ads clicks
- TikTok (ttclid): Conversions attributed to TikTok Ads clicks
- Includes unattributed conversions (no click ID present)
    `.trim(),
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD)"),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD)"),
      }),
    },
    responses: {
      "200": {
        description: "Click ID attribution data",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                by_platform: z.object({
                  google: PlatformAttributionSchema.nullable(),
                  meta: PlatformAttributionSchema.nullable(),
                  tiktok: PlatformAttributionSchema.nullable(),
                }),
                summary: ClickAttributionSummarySchema,
              }),
            }),
          },
        },
      },
      "401": { description: "Unauthorized" },
      "403": { description: "No organization access" },
      "500": { description: "Internal server error" },
    },
  };

  async handle(c: AppContext) {
    const orgId = c.get("org_id" as any) as string;
    const query = c.req.query();

    const dateFrom = query.date_from;
    const dateTo = query.date_to;

    // Get org_tag for querying events schema
    const tagMapping = await c.env.DB.prepare(`
      SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? AND is_active = 1
    `).bind(orgId).first<{ short_tag: string }>();

    if (!tagMapping) {
      // No tracking configured - return empty data
      return success(c, {
        by_platform: {
          google: null,
          meta: null,
          tiktok: null,
        },
        summary: {
          total_attributed_conversions: 0,
          total_attributed_revenue_cents: 0,
          unattributed_conversions: 0,
          unattributed_revenue_cents: 0,
          attribution_rate: 0,
        },
      });
    }

    try {
      const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
      if (!supabaseKey) {
        return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
      }

      const supabase = new SupabaseClient({
        url: c.env.SUPABASE_URL,
        serviceKey: supabaseKey,
      });

      // Query conversion_attribution table for all conversions in date range
      const params = new URLSearchParams();
      params.append("org_tag", `eq.${tagMapping.short_tag}`);
      params.append("conversion_timestamp", `gte.${dateFrom}T00:00:00Z`);
      params.append("conversion_timestamp", `lte.${dateTo}T23:59:59Z`);
      params.append("select", "gclid,fbclid,ttclid,conversion_value_cents,device_fingerprint_id,confidence_score");

      const records = await supabase.queryWithSchema<any[]>(
        `conversion_attribution?${params.toString()}`,
        "events",
        { method: "GET" }
      ) || [];

      // Aggregate by click ID type
      const googleData = { conversions: 0, revenue: 0, users: new Set<string>(), confidenceSum: 0, confidenceCount: 0 };
      const metaData = { conversions: 0, revenue: 0, users: new Set<string>(), confidenceSum: 0, confidenceCount: 0 };
      const tiktokData = { conversions: 0, revenue: 0, users: new Set<string>(), confidenceSum: 0, confidenceCount: 0 };
      const unattributedData = { conversions: 0, revenue: 0 };

      for (const record of records) {
        const hasGclid = !!record.gclid;
        const hasFbclid = !!record.fbclid;
        const hasTtclid = !!record.ttclid;
        const revenue = record.conversion_value_cents || 0;
        const userId = record.device_fingerprint_id;
        const confidence = record.confidence_score;

        // Prioritize: gclid > fbclid > ttclid (in case multiple are present)
        if (hasGclid) {
          googleData.conversions++;
          googleData.revenue += revenue;
          googleData.users.add(userId);
          if (confidence !== null && confidence !== undefined) {
            googleData.confidenceSum += Number(confidence);
            googleData.confidenceCount++;
          }
        } else if (hasFbclid) {
          metaData.conversions++;
          metaData.revenue += revenue;
          metaData.users.add(userId);
          if (confidence !== null && confidence !== undefined) {
            metaData.confidenceSum += Number(confidence);
            metaData.confidenceCount++;
          }
        } else if (hasTtclid) {
          tiktokData.conversions++;
          tiktokData.revenue += revenue;
          tiktokData.users.add(userId);
          if (confidence !== null && confidence !== undefined) {
            tiktokData.confidenceSum += Number(confidence);
            tiktokData.confidenceCount++;
          }
        } else {
          unattributedData.conversions++;
          unattributedData.revenue += revenue;
        }
      }

      // Build response
      const buildPlatformData = (
        data: typeof googleData,
        clickIdType: "gclid" | "fbclid" | "ttclid",
        platform: "google" | "meta" | "tiktok"
      ) => {
        if (data.conversions === 0) return null;
        return {
          click_id_type: clickIdType,
          platform,
          conversions: data.conversions,
          revenue_cents: data.revenue,
          avg_order_value_cents: data.conversions > 0 ? Math.round(data.revenue / data.conversions) : 0,
          unique_users: data.users.size,
          avg_confidence_score: data.confidenceCount > 0
            ? Math.round((data.confidenceSum / data.confidenceCount) * 100) / 100
            : null,
        };
      };

      const totalAttributed = googleData.conversions + metaData.conversions + tiktokData.conversions;
      const totalAttributedRevenue = googleData.revenue + metaData.revenue + tiktokData.revenue;
      const totalConversions = totalAttributed + unattributedData.conversions;

      return success(c, {
        by_platform: {
          google: buildPlatformData(googleData, "gclid", "google"),
          meta: buildPlatformData(metaData, "fbclid", "meta"),
          tiktok: buildPlatformData(tiktokData, "ttclid", "tiktok"),
        },
        summary: {
          total_attributed_conversions: totalAttributed,
          total_attributed_revenue_cents: totalAttributedRevenue,
          unattributed_conversions: unattributedData.conversions,
          unattributed_revenue_cents: unattributedData.revenue,
          attribution_rate: totalConversions > 0
            ? Math.round((totalAttributed / totalConversions) * 10000) / 100
            : 0,
        },
      });
    } catch (err: any) {
      console.error("Click attribution error:", err);
      return error(c, "INTERNAL_ERROR", "Failed to fetch click attribution data", 500);
    }
  }
}
