/**
 * Entity Analysis Endpoint
 *
 * GET /v1/analysis/entity/:level/:entity_id
 * Get analysis summary for a specific entity
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
  HierarchicalAnalyzer,
  AnalysisLevel
} from "../../../services/analysis";

export class GetEntityAnalysis extends OpenAPIRoute {
  public schema = {
    tags: ["Analysis"],
    summary: "Get entity analysis summary",
    operationId: "get-entity-analysis",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        level: z.enum(["ad", "adset", "campaign", "account", "cross_platform"]),
        entity_id: z.string()
      })
    },
    responses: {
      "200": {
        description: "Entity analysis summary",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                entity_id: z.string(),
                entity_name: z.string(),
                level: z.string(),
                platform: z.string().nullable(),
                summary: z.string(),
                metrics_snapshot: z.any(),
                days: z.number(),
                created_at: z.string()
              }).nullable()
            })
          }
        }
      },
      "404": {
        description: "Entity not found"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    if (!orgId) {
      return error(c, "UNAUTHORIZED", "Organization not found", 400);
    }

    const { level, entity_id } = c.req.param();

    // Initialize minimal services
    const supabaseKey = await getSecret(c.env.SUPABASE_SECRET_KEY);
    if (!supabaseKey) {
      return error(c, "CONFIGURATION_ERROR", "Supabase not configured", 500);
    }
    const supabase = new SupabaseClient({
      url: c.env.SUPABASE_URL,
      serviceKey: supabaseKey
    });

    const entityTree = new EntityTreeBuilder(supabase);
    const metrics = new MetricsFetcher(supabase);
    const llm = new LLMRouter({
      anthropicApiKey: "dummy",
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

    const summary = await analyzer.getEntitySummary(
      orgId,
      level as AnalysisLevel,
      entity_id
    );

    if (!summary) {
      return success(c, null);
    }

    // Parse metrics snapshot
    let metricsSnapshot;
    try {
      metricsSnapshot = JSON.parse(summary.metrics_snapshot);
    } catch {
      metricsSnapshot = [];
    }

    return success(c, {
      entity_id: summary.entity_id,
      entity_name: summary.entity_name,
      level: summary.level,
      platform: summary.platform,
      summary: summary.summary,
      metrics_snapshot: metricsSnapshot,
      days: summary.days,
      created_at: summary.created_at
    });
  }
}
