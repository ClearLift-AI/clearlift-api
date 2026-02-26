/**
 * Latest Analysis Endpoint
 *
 * GET /v1/analysis/latest
 * Get the most recent completed analysis results
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { getLatestAnalysis } from "../../../services/analysis/analysis-queries";

export class GetLatestAnalysis extends OpenAPIRoute {
  public schema = {
    tags: ["Analysis"],
    summary: "Get latest analysis results",
    operationId: "get-latest-analysis",
    security: [{ bearerAuth: [] }],
    responses: {
      "200": {
        description: "Latest analysis results",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                run_id: z.string(),
                cross_platform_summary: z.object({
                  summary: z.string(),
                  entity_name: z.string(),
                  created_at: z.string()
                }).nullable(),
                platform_summaries: z.array(z.object({
                  platform: z.string(),
                  entity_name: z.string(),
                  summary: z.string()
                })),
                created_at: z.string()
              }).nullable()
            })
          }
        }
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    if (!orgId) {
      return error(c, "UNAUTHORIZED", "Organization not found", 400);
    }

    const latest = await getLatestAnalysis(c.env.DB, orgId);

    if (!latest) {
      return success(c, null);
    }

    return success(c, {
      run_id: latest.runId,
      cross_platform_summary: latest.crossPlatformSummary ? {
        summary: latest.crossPlatformSummary.summary,
        entity_name: latest.crossPlatformSummary.entity_name,
        created_at: latest.crossPlatformSummary.created_at
      } : null,
      platform_summaries: latest.platformSummaries.map(s => ({
        platform: s.platform || "unknown",
        entity_name: s.entity_name,
        summary: s.summary
      })),
      created_at: latest.createdAt
    });
  }
}
