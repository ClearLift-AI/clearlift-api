/**
 * Click ID Attribution Endpoint
 *
 * Fetches conversion data grouped by click ID platform (Google/Meta/TikTok).
 * NOTE: This endpoint requires the conversion_attribution table to be populated
 * in D1 ANALYTICS_DB by the events processing pipeline.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";

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
 * Fetches conversion data grouped by click ID type.
 * Currently returns empty results as the D1 conversion_attribution table
 * needs to be populated by the events processing pipeline.
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

NOTE: Requires conversion_attribution data to be populated in D1.
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

    // Get org_tag for querying
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

    // TODO: Query D1 conversion_attribution table when available
    // For now, return empty results as this data is not yet populated in D1
    // The conversion_attribution table needs to be created and populated
    // by the events processing pipeline.

    console.log(`[ClickAttribution] Query for org ${orgId}, dates ${dateFrom} to ${dateTo} - returning empty (D1 table not yet populated)`);

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
}
