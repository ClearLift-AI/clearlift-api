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
import { structuredLog } from "../../../utils/structured-logger";

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
    // Retry once on failure — Secret Store bindings can have transient errors
    let anthropicKey = await getSecret(c.env.ANTHROPIC_API_KEY);
    let geminiKey = await getSecret(c.env.GEMINI_API_KEY);

    if (!anthropicKey || !geminiKey) {
      // One retry after 500ms — handles transient Secret Store failures
      await new Promise(r => setTimeout(r, 500));
      if (!anthropicKey) anthropicKey = await getSecret(c.env.ANTHROPIC_API_KEY);
      if (!geminiKey) geminiKey = await getSecret(c.env.GEMINI_API_KEY);
    }

    if (!anthropicKey || !geminiKey) {
      const missing = [!anthropicKey && 'ANTHROPIC_API_KEY', !geminiKey && 'GEMINI_API_KEY'].filter(Boolean).join(', ');
      structuredLog('ERROR', 'Secret Store keys unavailable', { endpoint: 'analysis', step: 'run', missing_keys: missing });
      return error(c, "CONFIGURATION_ERROR", "AI service not configured — secret keys unavailable", 500);
    }

    // Load settings from org (including LLM configuration and budget strategy)
    const settings = await c.env.DB.prepare(`
      SELECT
        custom_instructions,
        budget_optimization,
        daily_cap_cents,
        monthly_cap_cents,
        max_cac_cents,
        llm_default_provider,
        llm_claude_model,
        llm_gemini_model,
        llm_max_recommendations,
        llm_enable_exploration
      FROM ai_optimization_settings WHERE org_id = ?
    `).bind(orgId).first<{
      custom_instructions: string | null;
      budget_optimization: string | null;
      daily_cap_cents: number | null;
      monthly_cap_cents: number | null;
      max_cac_cents: number | null;
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
      },
      budgetStrategy: (settings?.budget_optimization || 'moderate') as 'conservative' | 'moderate' | 'aggressive',
      dailyCapCents: settings?.daily_cap_cents || null,
      monthlyCapCents: settings?.monthly_cap_cents || null,
      maxCacCents: settings?.max_cac_cents || null,
    };

    const jobs = new JobManager(c.env.DB);

    // Mark stuck jobs as failed (>30 min without completing)
    await c.env.DB.prepare(`
      UPDATE analysis_jobs
      SET status = 'failed', error_message = 'Timed out after 30 minutes'
      WHERE organization_id = ? AND status IN ('pending', 'in_progress', 'running')
        AND created_at < datetime('now', '-30 minutes')
    `).bind(orgId).run();

    // Dedup: return existing job if one is already running (<30 min old)
    const existingJob = await c.env.DB.prepare(`
      SELECT id, status FROM analysis_jobs
      WHERE organization_id = ? AND status IN ('pending', 'in_progress', 'running')
        AND created_at > datetime('now', '-30 minutes')
      ORDER BY created_at DESC LIMIT 1
    `).bind(orgId).first<{ id: string; status: string }>();

    if (existingJob) {
      return success(c, {
        job_id: existingJob.id,
        status: existingJob.status as 'pending',
        message: 'Analysis already running'
      });
    }

    // Expire old pending recommendations (>7 days) — keep recent ones so users can review
    // Previous behavior nuked ALL pending on re-run, giving users no time to act
    await c.env.DB.prepare(`
      UPDATE ai_decisions
      SET status = 'expired'
      WHERE organization_id = ? AND status = 'pending'
        AND expires_at < datetime('now')
    `).bind(orgId).run();

    // Create job in D1 (for status polling)
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
      structuredLog('ERROR', 'Workflow creation failed', { endpoint: 'analysis', step: 'run', error: err instanceof Error ? err.message : String(err) });
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
