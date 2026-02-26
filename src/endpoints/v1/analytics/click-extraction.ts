/**
 * Click Extraction Endpoint
 *
 * Triggers click extraction workflow to populate tracked_clicks
 * and conversion_attribution tables from raw event data.
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { structuredLog } from '../../../utils/structured-logger';

/**
 * GET /v1/analytics/click-extraction/stats
 *
 * Gets click extraction statistics for an organization.
 */
export class GetClickExtractionStats extends OpenAPIRoute {
  schema = {
    tags: ["Analytics"],
    summary: "Get click extraction statistics",
    description: "Returns statistics about extracted clicks and attribution for an organization.",
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        org_id: z.string().describe("Organization ID"),
      }),
    },
    responses: {
      "200": {
        description: "Click extraction statistics",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                total_clicks: z.number(),
                clicks_with_click_id: z.number(),
                converted_clicks: z.number(),
                clicks_by_platform: z.record(z.number()),
                clicks_by_touchpoint_type: z.record(z.number()),
                attribution_rate: z.number(),
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

    if (!c.env.ANALYTICS_DB) {
      return success(c, {
        total_clicks: 0,
        clicks_with_click_id: 0,
        converted_clicks: 0,
        clicks_by_platform: {},
        clicks_by_touchpoint_type: {},
        attribution_rate: 0,
      });
    }

    try {
      // Query stats directly from D1
      const stats = await c.env.ANALYTICS_DB.prepare(`
        SELECT
          COUNT(*) as total_clicks,
          SUM(CASE WHEN click_id IS NOT NULL THEN 1 ELSE 0 END) as clicks_with_click_id,
          SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) as converted_clicks
        FROM tracked_clicks
        WHERE organization_id = ?
      `).bind(orgId).first();

      const byPlatform = await c.env.ANALYTICS_DB.prepare(`
        SELECT platform, COUNT(*) as count
        FROM tracked_clicks
        WHERE organization_id = ? AND platform IS NOT NULL
        GROUP BY platform
      `).bind(orgId).all();

      const byType = await c.env.ANALYTICS_DB.prepare(`
        SELECT touchpoint_type, COUNT(*) as count
        FROM tracked_clicks
        WHERE organization_id = ?
        GROUP BY touchpoint_type
      `).bind(orgId).all();

      const totalClicks = (stats as any)?.total_clicks || 0;
      const clicksWithClickId = (stats as any)?.clicks_with_click_id || 0;
      const convertedClicks = (stats as any)?.converted_clicks || 0;

      return success(c, {
        total_clicks: totalClicks,
        clicks_with_click_id: clicksWithClickId,
        converted_clicks: convertedClicks,
        clicks_by_platform: Object.fromEntries(
          (byPlatform.results as any[]).map(r => [r.platform, r.count])
        ),
        clicks_by_touchpoint_type: Object.fromEntries(
          (byType.results as any[]).map(r => [r.touchpoint_type, r.count])
        ),
        attribution_rate: totalClicks > 0 ? (convertedClicks / totalClicks) * 100 : 0,
      });
    } catch (err) {
      structuredLog('ERROR', 'Click extraction stats query failed', { endpoint: 'analytics/click-extraction', error: err instanceof Error ? err.message : String(err) });
      return error(c, "STATS_ERROR", `Failed to get stats: ${err instanceof Error ? err.message : 'Unknown error'}`, 500);
    }
  }
}
