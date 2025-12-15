/**
 * Run Analysis Endpoint
 *
 * POST /v1/analysis/run
 * Triggers async hierarchical analysis for the organization
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

export class RunAnalysis extends OpenAPIRoute {
  public schema = {
    tags: ["Analysis"],
    summary: "Trigger hierarchical AI analysis",
    operationId: "run-analysis",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              days: z.number().min(1).max(90).optional().default(7),
              webhook_url: z.string().url().optional()
            })
          }
        }
      }
    },
    responses: {
      "200": {
        description: "Analysis job started",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: z.object({
                job_id: z.string(),
                status: z.literal("pending"),
                message: z.string()
              })
            })
          }
        }
      },
      "400": {
        description: "Bad request"
      },
      "401": {
        description: "Unauthorized"
      }
    }
  };

  public async handle(c: AppContext) {
    const orgId = c.get("org_id");
    if (!orgId) {
      return error(c, "UNAUTHORIZED", "Organization not found", 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const days = body.days || 7;
    const webhookUrl = body.webhook_url;

    // Check for API keys
    const anthropicKey = await getSecret(c.env.ANTHROPIC_API_KEY);
    const geminiKey = await getSecret(c.env.GEMINI_API_KEY);

    if (!anthropicKey || !geminiKey) {
      return error(c, "CONFIGURATION_ERROR", "AI service not configured", 500);
    }

    // Initialize services
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
      anthropicApiKey: anthropicKey.toString(),
      geminiApiKey: geminiKey.toString()
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
      anthropicKey.toString(),  // For agentic loop
      supabase  // For exploration tools
    );

    // Load custom instructions from org settings
    const settings = await c.env.DB.prepare(`
      SELECT custom_instructions FROM ai_optimization_settings WHERE org_id = ?
    `).bind(orgId).first<{ custom_instructions: string | null }>();
    const customInstructions = settings?.custom_instructions || null;

    // Create job
    const jobId = await jobs.createJob(orgId, days, webhookUrl);

    // Run analysis in background using waitUntil
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const result = await analyzer.analyzeOrganization(orgId, days, jobId, customInstructions);
          await jobs.completeJob(jobId, result.runId);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error("Analysis failed:", err);
          await jobs.failJob(jobId, message);
        }
      })()
    );

    return success(c, {
      job_id: jobId,
      status: "pending" as const,
      message: `Analysis started for ${days} day${days > 1 ? 's' : ''} lookback`
    });
  }
}
