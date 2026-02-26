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
import { structuredLog } from '../../../utils/structured-logger';

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

    // Query D1 conversion_attribution and tracked_clicks tables
    console.log(`[ClickAttribution] Query for org ${orgId}, dates ${dateFrom} to ${dateTo}`);

    if (!c.env.ANALYTICS_DB) {
      console.log(`[ClickAttribution] No ANALYTICS_DB - returning empty`);
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
      // Query attribution data grouped by click_id_type
      const attributionData = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          ca.click_id_type,
          COUNT(DISTINCT ca.conversion_id) as conversions,
          SUM(ca.credit_value_cents) as revenue_cents,
          COUNT(DISTINCT tc.anonymous_id) as unique_users
        FROM conversion_attribution ca
        LEFT JOIN tracked_clicks tc ON tc.click_id = ca.click_id
        WHERE ca.organization_id = ?
          AND ca.model = 'last_touch'
          AND ca.touchpoint_timestamp >= ?
          AND ca.touchpoint_timestamp <= ?
          AND ca.click_id_type IS NOT NULL
        GROUP BY ca.click_id_type
      `).bind(orgId, dateFrom, dateTo).all();

      // Query total conversions (including unattributed) from connector_events
      const totalConversions = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          COUNT(*) as total_conversions,
          COALESCE(SUM(value_cents), 0) as total_revenue_cents
        FROM connector_events
        WHERE organization_id = ?
          AND status IN ('succeeded', 'paid', 'completed', 'active')
          AND transacted_at >= ?
          AND transacted_at <= ?
      `).bind(orgId, dateFrom, dateTo + 'T23:59:59Z').first();

      // Build response
      const byPlatform: Record<string, any> = {
        google: null,
        meta: null,
        tiktok: null,
      };

      let totalAttributedConversions = 0;
      let totalAttributedRevenue = 0;

      for (const row of attributionData.results as any[]) {
        const platform =
          row.click_id_type === 'gclid' ? 'google' :
          row.click_id_type === 'fbclid' ? 'meta' :
          row.click_id_type === 'ttclid' ? 'tiktok' : null;

        if (platform) {
          byPlatform[platform] = {
            click_id_type: row.click_id_type,
            platform,
            conversions: row.conversions || 0,
            revenue_cents: row.revenue_cents || 0,
            avg_order_value_cents: row.conversions > 0
              ? Math.round(row.revenue_cents / row.conversions)
              : 0,
            unique_users: row.unique_users || 0,
            avg_confidence_score: 1.0, // Click IDs are 100% confidence
          };
          totalAttributedConversions += row.conversions || 0;
          totalAttributedRevenue += row.revenue_cents || 0;
        }
      }

      const totalConv = (totalConversions as any)?.total_conversions || 0;
      const totalRev = (totalConversions as any)?.total_revenue_cents || 0;

      return success(c, {
        by_platform: byPlatform,
        summary: {
          total_attributed_conversions: totalAttributedConversions,
          total_attributed_revenue_cents: totalAttributedRevenue,
          unattributed_conversions: Math.max(0, totalConv - totalAttributedConversions),
          unattributed_revenue_cents: Math.max(0, totalRev - totalAttributedRevenue),
          attribution_rate: totalConv > 0 ? (totalAttributedConversions / totalConv) * 100 : 0,
        },
      });
    } catch (err) {
      structuredLog('ERROR', 'Click attribution query failed', { endpoint: 'analytics/click-attribution', error: err instanceof Error ? err.message : String(err) });
      // Return empty on error
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
}
