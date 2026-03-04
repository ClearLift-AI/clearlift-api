/**
 * Internal Analysis Trigger Endpoint
 *
 * POST /internal/analysis/trigger
 *
 * Called by clearlift-cron queue-consumer via service binding to auto-schedule
 * AI analysis for organizations. Uses X-Internal-Key auth (not user auth).
 *
 * Mirrors the dedup logic from run.ts: fails stale jobs >30min, skips if already running.
 */

import { Context } from "hono";
import { verifyInternalAuth } from "../../../utils/internal-auth";
import { getSecret } from "../../../utils/secrets";
import { JobManager } from "../../../services/analysis/job-manager";
import { AnalysisWorkflowParams } from "../../../workflows/analysis-helpers";
import { structuredLog } from "../../../utils/structured-logger";

export async function handleInternalAnalysisTrigger(c: Context<{ Bindings: Env }>) {
  // Verify internal auth
  const isAuthed = await verifyInternalAuth(c.req, c.env as any);
  if (!isAuthed) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: { organization_id: string; days?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { organization_id: orgId, days = 7 } = body;
  if (!orgId) {
    return c.json({ error: "organization_id is required" }, 400);
  }

  // Verify API keys are configured
  let anthropicKey = await getSecret(c.env.ANTHROPIC_API_KEY);
  let geminiKey = await getSecret(c.env.GEMINI_API_KEY);

  if (!anthropicKey || !geminiKey) {
    await new Promise(r => setTimeout(r, 500));
    if (!anthropicKey) anthropicKey = await getSecret(c.env.ANTHROPIC_API_KEY);
    if (!geminiKey) geminiKey = await getSecret(c.env.GEMINI_API_KEY);
  }

  if (!anthropicKey || !geminiKey) {
    structuredLog('WARN', 'Skipping auto-analysis: AI keys not configured', {
      endpoint: 'internal-trigger', organization_id: orgId
    });
    return c.json({ skipped: true, reason: "AI service not configured" }, 200);
  }

  // Mark stuck jobs as failed (>30 min without completing)
  await c.env.DB.prepare(`
    UPDATE analysis_jobs
    SET status = 'failed', error_message = 'Timed out after 30 minutes'
    WHERE organization_id = ? AND status IN ('pending', 'in_progress', 'running')
      AND created_at < datetime('now', '-30 minutes')
  `).bind(orgId).run();

  // Dedup: skip if job already running (<30 min old)
  const existingJob = await c.env.DB.prepare(`
    SELECT id, status FROM analysis_jobs
    WHERE organization_id = ? AND status IN ('pending', 'in_progress', 'running')
      AND created_at > datetime('now', '-30 minutes')
    ORDER BY created_at DESC LIMIT 1
  `).bind(orgId).first<{ id: string; status: string }>();

  if (existingJob) {
    return c.json({
      skipped: true,
      reason: "Analysis already running",
      job_id: existingJob.id
    }, 200);
  }

  // Load org settings
  const settings = await c.env.DB.prepare(`
    SELECT
      custom_instructions,
      budget_optimization,
      daily_cap_cents,
      monthly_cap_cents,
      max_cac_cents,
      growth_strategy,
      ai_control,
      business_type,
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
    growth_strategy: string | null;
    ai_control: string | null;
    business_type: string | null;
    llm_default_provider: string | null;
    llm_claude_model: string | null;
    llm_gemini_model: string | null;
    llm_max_recommendations: number | null;
    llm_enable_exploration: number | null;
  }>();

  const analysisConfig: AnalysisWorkflowParams['config'] = {
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
    growthStrategy: (settings?.growth_strategy || 'balanced') as 'lean' | 'balanced' | 'bold',
    aiControl: (settings?.ai_control || 'copilot') as 'copilot' | 'autopilot',
    businessType: (settings?.business_type || 'lead_gen') as 'ecommerce' | 'lead_gen' | 'saas',
  };

  // Expire old pending recommendations
  await c.env.DB.prepare(`
    UPDATE ai_decisions
    SET status = 'expired'
    WHERE organization_id = ? AND status = 'pending'
      AND expires_at < datetime('now')
  `).bind(orgId).run();

  // Create job
  const jobs = new JobManager(c.env.DB);
  const jobId = await jobs.createJob(orgId, days);

  // Start workflow
  try {
    await c.env.ANALYSIS_WORKFLOW.create({
      id: jobId,
      params: {
        orgId,
        days,
        jobId,
        customInstructions: settings?.custom_instructions || null,
        config: analysisConfig
      }
    });

    structuredLog('INFO', 'Auto-analysis triggered', {
      endpoint: 'internal-trigger', organization_id: orgId, job_id: jobId
    });

    return c.json({ job_id: jobId, status: "pending" }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start workflow";
    structuredLog('ERROR', 'Auto-analysis workflow creation failed', {
      endpoint: 'internal-trigger', organization_id: orgId, error: message
    });
    await jobs.failJob(jobId, message);
    return c.json({ error: message }, 500);
  }
}
