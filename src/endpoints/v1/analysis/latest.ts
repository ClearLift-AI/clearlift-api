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
import { getSecret } from "../../../utils/secrets";
import { SupabaseClient } from "../../../services/supabase";
import {
  EntityTreeBuilder,
  MetricsFetcher,
  LLMRouter,
  PromptManager,
  AnalysisLogger,
  JobManager,
  HierarchicalAnalyzer
} from "../../../services/analysis";

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

    // Initialize minimal services needed for query
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }
    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      secretKey: supabaseKey
    });

    const entityTree = new EntityTreeBuilder(supabase);
    const metrics = new MetricsFetcher(supabase);
    const llm = new LLMRouter({
      anthropicApiKey: "dummy",  // Not needed for query
      geminiApiKey: "dummy"
    });
    const prompts = new PromptManager(c.env.AI_DB);
    const logger = new AnalysisLogger(c.env.AI_DB);
    const jobs = new JobManager(c.env.AI_DB);

    const analyzer = new HierarchicalAnalyzer(
      entityTree,
      metrics,
      llm,
      prompts,
      logger,
      jobs,
      c.env.AI_DB,
      "dummy"  // Not used for read-only operations
    );

    const latest = await analyzer.getLatestAnalysis(orgId);

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
