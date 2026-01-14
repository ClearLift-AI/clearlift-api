/**
 * Run Analysis Endpoint
 *
 * POST /v1/analysis/run
 * Triggers async hierarchical analysis for the organization
 * Uses Cloudflare Workflows for durable execution
 */

import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../../types";
import { success, error } from "../../../utils/response";
import { getSecret } from "../../../utils/secrets";
import { JobManager, AnalysisConfig } from "../../../services/analysis";
import { generateFacebookDemoRecommendations } from "../../../services/demo-recommendations";

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

    // Verify API keys are configured (workflow will access them directly)
    const anthropicKey = await getSecret(c.env.ANTHROPIC_API_KEY);
    const geminiKey = await getSecret(c.env.GEMINI_API_KEY);

    if (!anthropicKey || !geminiKey) {
      return error(c, "CONFIGURATION_ERROR", "AI service not configured", 500);
    }

    // Load settings from org (including LLM configuration)
    const settings = await c.env.DB.prepare(`
      SELECT
        custom_instructions,
        llm_default_provider,
        llm_claude_model,
        llm_gemini_model,
        llm_max_recommendations,
        llm_enable_exploration
      FROM ai_optimization_settings WHERE org_id = ?
    `).bind(orgId).first<{
      custom_instructions: string | null;
      llm_default_provider: string | null;
      llm_claude_model: string | null;
      llm_gemini_model: string | null;
      llm_max_recommendations: number | null;
      llm_enable_exploration: number | null;
    }>();

    const customInstructions = settings?.custom_instructions || null;

    // Build analysis configuration from org settings
    const analysisConfig: AnalysisConfig = {
      llm: {
        defaultProvider: (settings?.llm_default_provider || 'auto') as 'auto' | 'claude' | 'gemini',
        claudeModel: (settings?.llm_claude_model || 'haiku') as 'opus' | 'sonnet' | 'haiku',
        geminiModel: (settings?.llm_gemini_model || 'flash') as 'pro' | 'flash' | 'flash_lite'
      },
      agentic: {
        maxRecommendations: settings?.llm_max_recommendations ?? 3,
        enableExploration: settings?.llm_enable_exploration !== 0
      }
    };

    // Expire any pending recommendations from previous analysis runs
    // Note: Demo recommendations are preserved (they have [Demo] in reason)
    await c.env.AI_DB.prepare(`
      UPDATE ai_decisions
      SET status = 'expired'
      WHERE organization_id = ? AND status = 'pending' AND reason NOT LIKE '%[Demo]%'
    `).bind(orgId).run();

    // Seed Facebook demo recommendations if org has a Facebook connection
    // This ensures demo recommendations are always available for Meta App Review
    try {
      const fbConnection = await c.env.DB.prepare(`
        SELECT id FROM platform_connections
        WHERE organization_id = ? AND platform = 'facebook' AND is_active = 1
        LIMIT 1
      `).bind(orgId).first<{ id: string }>();

      if (fbConnection && c.env.ANALYTICS_DB) {
        const result = await generateFacebookDemoRecommendations(
          c.env.AI_DB,
          c.env.ANALYTICS_DB,
          orgId,
          fbConnection.id
        );

        if (result.success && result.recommendations_created > 0) {
          console.log(`[RunAnalysis] Seeded ${result.recommendations_created} Facebook demo recommendations for org ${orgId}`);
        }
      }
    } catch (demoError) {
      // Non-critical - don't fail the analysis if demo seeding fails
      console.warn(`[RunAnalysis] Failed to seed demo recommendations (non-critical):`, demoError);
    }

    // Create job in D1 (for status polling)
    const jobs = new JobManager(c.env.AI_DB);
    const jobId = await jobs.createJob(orgId, days, webhookUrl);

    // Start the durable workflow (replaces waitUntil)
    // Workflow handles all LLM calls with unlimited wall-clock time for I/O
    try {
      await c.env.ANALYSIS_WORKFLOW.create({
        id: jobId,
        params: {
          orgId,
          days,
          jobId,
          customInstructions,
          config: analysisConfig
        }
      });
    } catch (err) {
      // If workflow creation fails, mark job as failed
      const message = err instanceof Error ? err.message : "Failed to start workflow";
      console.error("Workflow creation failed:", err);
      await jobs.failJob(jobId, message);
      return error(c, "WORKFLOW_ERROR", message, 500);
    }

    return success(c, {
      job_id: jobId,
      status: "pending" as const,
      message: `Analysis started for ${days} day${days > 1 ? 's' : ''} lookback`
    });
  }
}
