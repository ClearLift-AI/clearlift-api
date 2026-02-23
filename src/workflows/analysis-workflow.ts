/**
 * Analysis Workflow
 *
 * Cloudflare Workflow for durable AI analysis execution.
 * Migrated from waitUntil() to handle long-running analysis jobs
 * without timing out during LLM call waits.
 *
 * Step Structure (v2 — math-first, Feb 2026):
 * 1. build_entity_tree - Fetch from D1, return serialized tree
 * 2. compute_portfolio_analysis - SQL-based math: KPIs, trends, anomaly flags for ALL entities
 *    (replaces per-entity LLM calls — 2-3 SQL queries instead of 500+ LLM calls)
 * 3. agentic_init + agentic_iterations - Agent gets structured portfolio data + exploration tools
 * Final. complete_job - Mark job complete in D1
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import {
  AnalysisWorkflowParams,
  SerializedEntityTree,
  SerializedEntity,
  AgenticIterationResult,
  AccumulatedInsightData,
  serializeEntityTree,
} from './analysis-helpers';
import { EntityTreeBuilder, EntityLevel } from '../services/analysis/entity-tree';
import { DateRange } from '../services/analysis/metrics-fetcher';
import { JobManager } from '../services/analysis/job-manager';
import { GEMINI_MODELS, calculateCostCents } from '../services/analysis/llm-provider';
import {
  getToolDefinitions,
  isRecommendationTool,
  isTerminateAnalysisTool,
  isGeneralInsightTool,
  parseToolCallToRecommendation,
  Recommendation,
} from '../services/analysis/recommendation-tools';
import {
  getExplorationToolDefinitions,
  getExplorationToolsForOrg,
  isExplorationTool,
  ExplorationToolExecutor
} from '../services/analysis/exploration-tools';
import {
  createSimulationCache,
  executeSimulateChange,
  executeRecommendationWithSimulation,
  getToolsWithSimulationGeneric,
  requiresSimulation,
  SimulationCache,
  ToolExecutionContext,
  SIMULATE_CHANGE_TOOL
} from '../services/analysis/simulation-executor';
import { SimulationResult } from '../services/analysis/simulation-service';
import { getSecret } from '../utils/secrets';
import {
  createAgenticClient,
  AgenticClient,
  AgenticCallOptions,
  AgenticToolDef,
  AgenticToolResult,
} from '../services/analysis/agentic-client';
import { LiveApiExecutor, QUERY_API_TOOL } from '../services/analysis/live-api-executor';

/**
 * Result from the complete workflow
 */
export interface AnalysisWorkflowResult {
  runId: string;
  crossPlatformSummary: string;
  platformSummaries: Record<string, string>;
  entityCount: number;
  recommendations: Recommendation[];
  agenticIterations: number;
  stoppedReason: 'max_recommendations' | 'no_tool_calls' | 'max_iterations' | 'early_termination';
  terminationReason?: string;
}

/**
 * Build a compact JSON summary of the entity tree for the dashboard tree visualization.
 * Format: JSON array of { name, platform, level, children: [...] } — kept under 4KB.
 */
function buildTreeSummaryForEvents(tree: SerializedEntityTree): string {
  type TreeNode = { n: string; p: string; l: string; c?: TreeNode[] };
  const buildNode = (entity: SerializedEntity): TreeNode => {
    const node: TreeNode = { n: entity.name, p: entity.platform, l: entity.level };
    if (entity.children && entity.children.length > 0) {
      node.c = entity.children.map(buildNode);
    }
    return node;
  };
  const roots = tree.accounts.map(([, entity]) => buildNode(entity));
  const json = JSON.stringify(roots);
  // Truncate if too large (keep under 4KB for D1 TEXT column efficiency)
  if (json.length > 4000) {
    return json.substring(0, 3997) + '...';
  }
  return json;
}

/**
 * Create a short human-readable summary of a tool call's input (no PII, no full JSON)
 */
function summarizeToolInput(toolCall: { name: string; input: any }): string {
  const input = toolCall.input || {};
  switch (toolCall.name) {
    case 'set_budget':
      return `Set ${input.platform || ''} ${input.entity_type || 'campaign'} '${input.entity_name || input.entity_id || ''}' budget to $${input.daily_budget || input.amount || '?'}/day`;
    case 'set_status':
      return `Set ${input.platform || ''} ${input.entity_type || 'campaign'} '${input.entity_name || input.entity_id || ''}' to ${input.status || '?'}`;
    case 'simulate_change':
      return `Simulate ${input.change_type || 'change'} for ${input.platform || ''} ${input.entity_type || 'campaign'} '${input.entity_name || input.entity_id || ''}'`;
    case 'general_insight':
      return input.title || 'General insight';
    case 'terminate_analysis':
      return `Analysis complete: ${(input.reason || '').slice(0, 100)}`;
    case 'set_audience':
      return `Set audience for ${input.platform || ''} ${input.entity_name || input.entity_id || ''}`;
    case 'reallocate_budget':
      return `Reallocate budget: ${input.from_entity_name || ''} → ${input.to_entity_name || ''}`;
    default:
      // Exploration tools (query_*)
      if (toolCall.name.startsWith('query_')) {
        return `Query ${toolCall.name.replace('query_', '').replace(/_/g, ' ')}`;
      }
      return toolCall.name;
  }
}

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {
  /**
   * Main workflow execution
   */
  async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep): Promise<AnalysisWorkflowResult> {
    const { orgId, days, jobId, customInstructions, config } = event.payload;
    const runId = crypto.randomUUID().replace(/-/g, '');

    try {
    // Step 0: Cleanup expired recommendations only — keep recent pending ones
    // Previous behavior deleted ALL pending on re-run, giving users no time to act
    await step.do('cleanup_expired', {
      retries: { limit: 2, delay: '1 second' },
      timeout: '30 seconds'
    }, async () => {
      // Delete ALL pending recommendations — new analysis replaces them entirely
      const result = await this.env.DB.prepare(`
        DELETE FROM ai_decisions
        WHERE organization_id = ?
        AND status = 'pending'
      `).bind(orgId).run();

      console.log(`[Analysis] Cleared ${result.meta?.changes ?? 0} pending recommendations for org ${orgId}`);
    });

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const dateRange: DateRange = {
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0]
    };

    // Step 1: Build entity tree (using D1 ANALYTICS_DB)
    const entityTree = await step.do('build_entity_tree', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
      timeout: '2 minutes'
    }, async () => {
      const treeBuilder = new EntityTreeBuilder(this.env.ANALYTICS_DB);
      const tree = await treeBuilder.buildTree(orgId);

      // Update job with total entities (+2 for cross_platform and recommendations)
      const jobs = new JobManager(this.env.DB);
      await jobs.startJob(jobId, tree.totalEntities + 2);

      return serializeEntityTree(tree);
    });

    // Log entity tree structure so dashboard can build the tree visualization
    // Store full tree in tool_input (unbounded JSON), truncated preview in tool_input_summary
    try {
      const treeSummary = buildTreeSummaryForEvents(entityTree);
      const fullTreeJson = (() => {
        type TreeNode = { n: string; p: string; l: string; c?: TreeNode[] };
        const buildNode = (entity: SerializedEntity): TreeNode => {
          const node: TreeNode = { n: entity.name, p: entity.platform, l: entity.level };
          if (entity.children && entity.children.length > 0) {
            node.c = entity.children.map(buildNode);
          }
          return node;
        };
        return JSON.stringify(entityTree.accounts.map(([, entity]) => buildNode(entity)));
      })();
      await this.env.DB.prepare(
        `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status, tool_input) VALUES (?, ?, 0, 'entity_tree', NULL, ?, NULL, ?)`
      ).bind(jobId, orgId, treeSummary, fullTreeJson).run();
    } catch (e) { /* non-critical */ }

    // Step 2: Compute portfolio analysis via SQL (replaces per-entity LLM calls)
    // Instead of making 500+ LLM calls (one per entity), we run a few SQL queries to
    // compute campaign-level KPIs, trends, and anomaly flags deterministically.
    // The agent gets a structured, ranked summary — massively parallelizable math, not serial LLM calls.
    const portfolioResult = await step.do('compute_portfolio_analysis', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
      timeout: '2 minutes'
    }, async () => {
      const jobs = new JobManager(this.env.DB);
      return await this.computePortfolioAnalysis(orgId, entityTree, dateRange, days, jobId, jobs);
    });

    const { crossPlatformSummary, platformSummaries } = portfolioResult;
    const additionalContext = portfolioResult.additionalContext || '';
    let processedCount = portfolioResult.processedCount;
    // Active tree is the full entity tree — agent uses exploration tools for drill-down
    const activeTree = entityTree;

    // Steps 7+: Agentic loop (dynamic iterations)
    const maxIterations = 200;
    // Separate limits: 1 insight (accumulated) + up to 3 action recommendations = 4 total max
    const maxActionRecommendations = config?.agentic?.maxRecommendations
      ? Math.min(config.agentic.maxRecommendations - 1, 3)  // Reserve 1 slot for insight
      : 3;
    const enableExploration = config?.agentic?.enableExploration !== false;

    let recommendations: Recommendation[] = [];
    let actionRecommendations: Recommendation[] = [];  // Track action recs separately
    let agenticMessages: any[] = [];
    let iterations = 0;
    let stoppedReason: 'max_recommendations' | 'no_tool_calls' | 'max_iterations' | 'early_termination' = 'max_iterations';
    let terminationReason: string | undefined;

    // Track accumulated insight state across iterations
    let accumulatedInsightId: string | null = null;
    let accumulatedInsights: AccumulatedInsightData[] = [];
    let hasInsight = false;  // Track if we've generated an insight

    // Create simulation cache for this analysis run (shared across iterations)
    // This cache persists the simulation results so the LLM must acknowledge them
    // before creating recommendations with REAL numbers instead of guessed ones.
    const simulationCache = createSimulationCache();

    // LLM token usage tracking (accumulated across all iterations)
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Initialize agentic loop context
    const agenticContext = await step.do('agentic_init', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      timeout: '2 minutes'
    }, async () => {
      const jobs = new JobManager(this.env.DB);
      await jobs.updateProgress(jobId, processedCount, 'recommendations');

      // Fetch recent recommendation history
      const recentRecs = await this.getRecentRecommendations(orgId);

      // Build initial messages
      const contextPrompt = this.buildAgenticContextPrompt(crossPlatformSummary, platformSummaries, additionalContext);

      return {
        recentRecs,
        contextPrompt,
        systemPrompt: this.buildAgenticSystemPrompt(days, customInstructions, recentRecs, config)
      };
    });

    // Create the agentic client (Gemini Flash for cost efficiency)
    const geminiKey = await getSecret(this.env.GEMINI_API_KEY);
    const agenticClient = createAgenticClient('gemini', geminiKey!, GEMINI_MODELS.FLASH);

    agenticMessages = [agenticClient.buildUserMessage(agenticContext.contextPrompt)];

    // Log phase change for agentic loop
    try {
      await this.env.DB.prepare(
        `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'phase_change', NULL, ?, NULL)`
      ).bind(jobId, orgId, 'Starting AI recommendations').run();
    } catch (e) { /* non-critical */ }

    // Run agentic iterations as separate steps
    // Loop continues until: we have an insight AND 3 action recs, OR max iterations, OR early termination
    const budgetStrategy = config?.budgetStrategy || 'moderate';
    let nudgeUsed = false;  // Only nudge once to avoid infinite loops

    // Sequential pattern tracker: detect when LLM makes one exploration call per turn
    let consecutiveSingleExplore = 0;
    let lastSingleExploreTool = '';
    let sequentialNudgeFired = false;

    // Fake a 100-turn budget to create urgency (real limit is 200)
    const displayMaxIterations = 100;

    while (iterations < maxIterations && actionRecommendations.length < maxActionRecommendations) {
      iterations++;

      // Inject iteration counter as semantic pressure before each LLM call
      const turnBudgetMessage = `⏱ Turn ${iterations}/${displayMaxIterations}. Remaining action slots: ${maxActionRecommendations - actionRecommendations.length}/${maxActionRecommendations}. Prioritize: explore in parallel → simulate → recommend → terminate.`;

      // Inject iteration pressure as a separate user message
      const messagesWithPressure = [...agenticMessages];
      // Only inject pressure after the first turn (don't pollute the initial context)
      if (iterations > 1) {
        messagesWithPressure.push(agenticClient.buildUserMessage(turnBudgetMessage));
      }

      const iterResult = await step.do(`agentic_iteration_${iterations}`, {
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
        timeout: '5 minutes'
      }, async () => {
        return await this.runAgenticIteration(
          orgId,
          runId,
          jobId,
          iterations,
          messagesWithPressure,
          agenticContext.systemPrompt,
          recommendations,
          actionRecommendations,
          maxActionRecommendations,
          enableExploration,
          accumulatedInsightId,
          accumulatedInsights,
          hasInsight,
          simulationCache,  // Pass simulation cache for enforced simulation before recommendations
          agenticClient
        );
      });

      // Update state from iteration result
      agenticMessages = iterResult.messages;
      recommendations = iterResult.recommendations;
      actionRecommendations = iterResult.actionRecommendations || actionRecommendations;

      // Accumulate LLM token usage
      totalInputTokens += iterResult.inputTokens || 0;
      totalOutputTokens += iterResult.outputTokens || 0;

      // Merge accumulated insight state
      if (iterResult.accumulatedInsightId) {
        accumulatedInsightId = iterResult.accumulatedInsightId;
        hasInsight = true;
      }
      if (iterResult.accumulatedInsights) {
        accumulatedInsights = iterResult.accumulatedInsights;
      }

      // Track sequential exploration patterns and inject efficiency nudge
      const iterToolCalls = iterResult.toolCallNames || [];
      const explorationCalls = iterToolCalls.filter((n: string) => n.startsWith('query_') || n === 'simulate_change');
      if (explorationCalls.length === 1 && iterToolCalls.length === 1) {
        const toolName = explorationCalls[0];
        if (toolName === lastSingleExploreTool) {
          consecutiveSingleExplore++;
        } else {
          consecutiveSingleExplore = 1;
          lastSingleExploreTool = toolName;
        }
      } else {
        consecutiveSingleExplore = 0;
        lastSingleExploreTool = '';
      }

      // Fire nudge if 3+ consecutive single-tool exploration turns
      if (consecutiveSingleExplore >= 3 && !sequentialNudgeFired) {
        const nudgeToolName = lastSingleExploreTool;
        const nudgeCount = consecutiveSingleExplore;
        sequentialNudgeFired = true;
        consecutiveSingleExplore = 0;
        agenticMessages = [
          ...iterResult.messages,
          agenticClient.buildUserMessage(
            `Efficiency tip: You've called ${nudgeToolName} individually ${nudgeCount} turns in a row. ` +
            `Call multiple tools in a single response to save turns — for example, query multiple metrics at once. ` +
            `You have ${displayMaxIterations - iterations} turns remaining.`
          )
        ];
        console.log(`[Analysis] Sequential pattern nudge fired: ${nudgeToolName} called ${nudgeCount} times individually`);
        continue;
      }

      if (iterResult.shouldStop) {
        // Pre-termination nudge: if the agent is stopping with zero actions, push it to
        // generate at least one concrete recommendation before giving up. Users pay for
        // analysis — "everything looks great" with no actions is not acceptable output.
        if (
          !nudgeUsed &&
          actionRecommendations.length === 0 &&
          (iterResult.stopReason === 'no_tool_calls' || iterResult.stopReason === 'early_termination')
        ) {
          nudgeUsed = true;

          const strategyNudge = budgetStrategy === 'aggressive'
            ? `You are in AGGRESSIVE budget mode — the user expects bold action recommendations.\n` +
              `- Are there top performers whose budget could be increased by 10-20%?\n` +
              `- Are there paused campaigns with strong historical ROAS worth re-enabling?\n`
            : budgetStrategy === 'conservative'
            ? `You are in CONSERVATIVE budget mode — the user wants to reduce waste.\n` +
              `- Are there entities with below-average efficiency that should be paused?\n` +
              `- Can any budgets be decreased to improve blended CPA?\n`
            : `You are in MODERATE budget mode — the user wants to reallocate for better results.\n` +
              `- Can you shift budget from underperformers to top performers (net-zero change)?\n` +
              `- Are there any entities to pause and redistribute their spend to winners?\n`;

          agenticMessages = [
            ...iterResult.messages,
            agenticClient.buildUserMessage(
              `IMPORTANT: You have not made any action recommendations yet. Insights alone are not enough — ` +
              `the user is paying for actionable optimization suggestions, not just observations.\n\n` +
              `${strategyNudge}` +
              `- Are there underperforming entities that should be paused to free up budget?\n` +
              `- Can you reallocate budget from low-efficiency to high-efficiency entities?\n\n` +
              `Even if the portfolio is performing well overall, there are ALWAYS optimization opportunities:\n` +
              `- Reallocating 10-15% from the weakest campaign to the strongest\n` +
              `- Adjusting budgets to match efficiency scores (higher budget for higher efficiency)\n` +
              `- Pausing campaigns with declining trends before they waste more spend\n\n` +
              `Use simulate_change to model at least ONE concrete action, then recommend it. ` +
              `If you genuinely cannot find ANY action after this review, call terminate_analysis ` +
              `with a specific explanation of why no optimization is possible.`
            )
          ];
          console.log(`[Analysis] Pre-termination nudge: LLM stopped with no actions (${budgetStrategy} mode), injecting retry prompt`);
          continue;  // Re-enter the loop for another iteration
        }

        stoppedReason = iterResult.stopReason || 'no_tool_calls';
        terminationReason = iterResult.terminationReason;
        break;
      }
    }

    // Get final summary if we stopped due to max recommendations
    let finalSummary = crossPlatformSummary;
    if (stoppedReason === 'max_recommendations') {
      const finalSummaryResult = await step.do('agentic_final_summary', {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
        timeout: '2 minutes'
      }, async () => {
        return await this.getAgenticFinalSummary(
          agenticMessages,
          agenticContext.systemPrompt + `\n\nYou have made ${maxActionRecommendations} recommendations which is the maximum. Provide a brief final summary.`,
          enableExploration,
          orgId,
          agenticClient
        );
      });
      finalSummary = finalSummaryResult.summary || crossPlatformSummary;
      totalInputTokens += finalSummaryResult.inputTokens;
      totalOutputTokens += finalSummaryResult.outputTokens;
    }

    // Increment for recommendations step
    processedCount++;

    // Final step: Complete the job and record LLM usage
    const estimatedCostCents = calculateCostCents('gemini', GEMINI_MODELS.FLASH, totalInputTokens, totalOutputTokens);
    await step.do('complete_job', {
      retries: { limit: 3, delay: '1 second' },
      timeout: '30 seconds'
    }, async () => {
      const jobs = new JobManager(this.env.DB);
      await jobs.updateProgress(jobId, processedCount, 'recommendations');
      await jobs.completeJob(jobId, runId, stoppedReason, terminationReason);

      // Write LLM usage stats to analysis_jobs
      await this.env.DB.prepare(`
        UPDATE analysis_jobs
        SET total_input_tokens = ?,
            total_output_tokens = ?,
            estimated_cost_cents = ?,
            llm_provider = ?,
            llm_model = ?
        WHERE id = ?
      `).bind(
        totalInputTokens,
        totalOutputTokens,
        estimatedCostCents,
        'gemini',
        GEMINI_MODELS.FLASH,
        jobId
      ).run();

      console.log(`[Analysis] LLM usage for job ${jobId}: ${totalInputTokens} in / ${totalOutputTokens} out, ~${estimatedCostCents}c`);
    });

    // Generate CAC predictions from recommendations with simulation data
    // This populates the CAC Timeline chart with mathematically-calculated forecasts
    await step.do('generate_cac_predictions', {
      retries: { limit: 2, delay: '1 second' },
      timeout: '30 seconds'
    }, async () => {
      // Get pending recommendations with simulation data
      const recsResult = await this.env.DB.prepare(`
        SELECT id, simulation_data, predicted_impact
        FROM ai_decisions
        WHERE organization_id = ?
          AND status = 'pending'
          AND simulation_data IS NOT NULL
      `).bind(orgId).all<{
        id: string;
        simulation_data: string;
        predicted_impact: number;
      }>();

      if (!recsResult.results || recsResult.results.length === 0) {
        console.log('[Analysis] No recommendations with simulation data to generate predictions');
        return;
      }

      // Get current CAC from cac_history (in ANALYTICS_DB)
      const currentCacResult = await this.env.ANALYTICS_DB.prepare(`
        SELECT cac_cents FROM cac_history
        WHERE organization_id = ?
        ORDER BY date DESC
        LIMIT 1
      `).bind(orgId).first<{ cac_cents: number }>();

      // If no CAC history, try to calculate from platform metrics
      let currentCac = currentCacResult?.cac_cents || 0;
      if (currentCac === 0) {
        // Calculate from recent platform metrics using unified ad_metrics table
        const metricsResult = await this.env.ANALYTICS_DB.prepare(`
          SELECT SUM(spend_cents) as spend, SUM(conversions) as conversions
          FROM ad_metrics
          WHERE organization_id = ?
            AND entity_type = 'campaign'
            AND metric_date >= date('now', '-7 days')
        `).bind(orgId).first<{ spend: number; conversions: number }>();

        if (metricsResult?.conversions && metricsResult.conversions > 0) {
          currentCac = Math.round(metricsResult.spend / metricsResult.conversions);
        }
      }

      if (currentCac === 0) {
        console.log('[Analysis] No CAC data available to generate predictions');
        return;
      }

      // Calculate aggregate impact from all recommendations
      let totalImpactPercent = 0;
      const recommendationIds: string[] = [];

      for (const rec of recsResult.results) {
        totalImpactPercent += rec.predicted_impact || 0;
        recommendationIds.push(rec.id);
      }

      // Generate predictions for next 3 days
      const today = new Date();
      for (let i = 1; i <= 3; i++) {
        const predDate = new Date(today);
        predDate.setDate(predDate.getDate() + i);
        const dateStr = predDate.toISOString().split('T')[0];

        // Linear interpolation of impact over 3 days
        const dayImpact = (totalImpactPercent * i) / 3;
        const predictedCac = Math.round(currentCac * (1 + dayImpact / 100));

        await this.env.DB.prepare(`
          INSERT INTO cac_predictions (
            organization_id, prediction_date, predicted_cac_cents,
            recommendation_ids, analysis_run_id, assumptions
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(organization_id, prediction_date)
          DO UPDATE SET
            predicted_cac_cents = excluded.predicted_cac_cents,
            recommendation_ids = excluded.recommendation_ids,
            analysis_run_id = excluded.analysis_run_id,
            assumptions = excluded.assumptions,
            created_at = datetime('now')
        `).bind(
          orgId,
          dateStr,
          predictedCac,
          JSON.stringify(recommendationIds),
          runId,
          JSON.stringify({
            current_cac_cents: currentCac,
            total_impact_percent: totalImpactPercent,
            recommendation_count: recommendationIds.length
          })
        ).run();
      }

      console.log(`[Analysis] Generated CAC predictions: ${totalImpactPercent.toFixed(1)}% impact from ${recommendationIds.length} recommendations`);
    });

    return {
      runId,
      crossPlatformSummary: finalSummary,
      platformSummaries,
      entityCount: activeTree.totalEntities,
      recommendations,
      agenticIterations: iterations,
      stoppedReason,
      terminationReason
    };

    } catch (err) {
      // Top-level error handler: mark job as failed so the dashboard stops polling
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Analysis] Workflow failed for job ${jobId}: ${errorMessage}`);
      try {
        const jobs = new JobManager(this.env.DB);
        await jobs.failJob(jobId, errorMessage);
      } catch (failErr) {
        console.error(`[Analysis] Failed to mark job ${jobId} as failed:`, failErr);
      }
      throw err; // Re-throw so Cloudflare Workflows marks the instance as failed
    }
  }


  /**
   * Compute portfolio analysis via SQL — replaces per-entity LLM calls.
   *
   * Instead of making 500+ LLM calls (one per entity at each level), we run
   * a handful of SQL queries to compute campaign-level KPIs, trends, and flags
   * deterministically. This is massively parallelizable and completes in seconds.
   *
   * The agent gets a structured, ranked summary:
   * - Top performers (by ROAS)
   * - Underperformers (high CPA, low ROAS)
   * - Paused campaigns with strong historical performance
   * - Portfolio totals + per-platform breakdown
   * - Trend data (WoW changes)
   * - Additional context (journeys, CAC, revenue sources)
   *
   * Returns the same shape as the old generateCrossPlatformSummary for agentic loop compatibility.
   */
  private async computePortfolioAnalysis(
    orgId: string,
    entityTree: SerializedEntityTree,
    dateRange: DateRange,
    days: number,
    jobId: string,
    jobs: JobManager
  ): Promise<{
    crossPlatformSummary: string;
    platformSummaries: Record<string, string>;
    processedCount: number;
    additionalContext: string;
  }> {
    // Update job progress: portfolio analysis phase
    await jobs.updateProgress(jobId, 0, 'campaign');

    // Log phase change
    try {
      await this.env.DB.prepare(
        `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'phase_change', NULL, ?, NULL)`
      ).bind(jobId, orgId, 'Computing portfolio analysis').run();
    } catch (e) { /* non-critical */ }

    const fmt = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (num: number, den: number) => den > 0 ? (num / den * 100).toFixed(1) + '%' : 'N/A';

    // ── Query 1: Campaign-level KPIs for the analysis window ──
    const campaignMetrics = await this.env.ANALYTICS_DB.prepare(`
      SELECT
        c.id as campaign_uuid,
        c.campaign_id as campaign_external_id,
        c.campaign_name,
        c.campaign_status,
        c.platform,
        c.account_id,
        COALESCE(SUM(am.spend_cents), 0) as spend_cents,
        COALESCE(SUM(am.impressions), 0) as impressions,
        COALESCE(SUM(am.clicks), 0) as clicks,
        COALESCE(SUM(am.conversions), 0) as conversions,
        COALESCE(SUM(am.conversion_value_cents), 0) as revenue_cents,
        MIN(am.metric_date) as first_active,
        MAX(am.metric_date) as last_active,
        COUNT(DISTINCT am.metric_date) as active_days
      FROM ad_campaigns c
      LEFT JOIN ad_metrics am ON am.entity_ref = c.id
        AND am.entity_type = 'campaign'
        AND am.organization_id = c.organization_id
        AND am.metric_date >= ? AND am.metric_date <= ?
      WHERE c.organization_id = ?
        AND c.campaign_status != 'REMOVED'
      GROUP BY c.id
      ORDER BY spend_cents DESC
    `).bind(dateRange.start, dateRange.end, orgId).all<{
      campaign_uuid: string;
      campaign_external_id: string;
      campaign_name: string;
      campaign_status: string;
      platform: string;
      account_id: string;
      spend_cents: number;
      impressions: number;
      clicks: number;
      conversions: number;
      revenue_cents: number;
      first_active: string | null;
      last_active: string | null;
      active_days: number;
    }>();

    const campaigns = campaignMetrics.results || [];

    // ── Query 1b: Verified revenue from connectors (Stripe, Shopify, etc.) ──
    // Platform-reported revenue (ad_metrics.conversion_value_cents) is usually near-zero
    // because payment platforms don't share revenue back to ad networks.
    // Verified revenue from connector_events IS the ground truth.
    let verifiedRevenueCents = 0;
    let verifiedConversions = 0;
    try {
      const verified = await this.env.ANALYTICS_DB.prepare(`
        SELECT COUNT(*) as conversions, COALESCE(SUM(value_cents), 0) as revenue_cents
        FROM conversions
        WHERE organization_id = ?
          AND conversion_timestamp >= ? AND conversion_timestamp <= ?
      `).bind(orgId, dateRange.start, dateRange.end).first<{
        conversions: number; revenue_cents: number;
      }>();
      if (verified) {
        verifiedRevenueCents = verified.revenue_cents || 0;
        verifiedConversions = verified.conversions || 0;
      }
    } catch { /* conversions table may be empty */ }

    const hasVerifiedRevenue = verifiedRevenueCents > 0;

    // ── Query 2: Prior-period metrics for trend calculation ──
    const priorStart = new Date(dateRange.start);
    priorStart.setDate(priorStart.getDate() - days);
    const priorEnd = new Date(dateRange.start);
    priorEnd.setDate(priorEnd.getDate() - 1);

    const priorMetrics = await this.env.ANALYTICS_DB.prepare(`
      SELECT
        entity_ref as campaign_uuid,
        COALESCE(SUM(spend_cents), 0) as spend_cents,
        COALESCE(SUM(impressions), 0) as impressions,
        COALESCE(SUM(clicks), 0) as clicks,
        COALESCE(SUM(conversions), 0) as conversions,
        COALESCE(SUM(conversion_value_cents), 0) as revenue_cents
      FROM ad_metrics
      WHERE organization_id = ?
        AND entity_type = 'campaign'
        AND metric_date >= ? AND metric_date <= ?
      GROUP BY entity_ref
    `).bind(orgId, priorStart.toISOString().split('T')[0], priorEnd.toISOString().split('T')[0]).all<{
      campaign_uuid: string;
      spend_cents: number;
      impressions: number;
      clicks: number;
      conversions: number;
      revenue_cents: number;
    }>();

    const priorMap = new Map<string, typeof priorMetrics.results[0]>();
    for (const r of priorMetrics.results || []) {
      priorMap.set(r.campaign_uuid, r);
    }

    // ── Query 3: Historical performance for paused campaigns ──
    const pausedHistorical = await this.env.ANALYTICS_DB.prepare(`
      SELECT
        entity_ref as campaign_uuid,
        COALESCE(SUM(spend_cents), 0) as total_spend,
        COALESCE(SUM(conversions), 0) as total_conversions,
        COALESCE(SUM(conversion_value_cents), 0) as total_revenue,
        MAX(metric_date) as last_active_date
      FROM ad_metrics
      WHERE organization_id = ?
        AND entity_type = 'campaign'
      GROUP BY entity_ref
    `).bind(orgId).all<{
      campaign_uuid: string;
      total_spend: number;
      total_conversions: number;
      total_revenue: number;
      last_active_date: string;
    }>();

    const historicalMap = new Map<string, typeof pausedHistorical.results[0]>();
    for (const r of pausedHistorical.results || []) {
      historicalMap.set(r.campaign_uuid, r);
    }

    // ── Compute derived metrics + classify campaigns ──
    interface CampaignAnalysis {
      name: string;
      platform: string;
      status: string;
      spend_cents: number;
      impressions: number;
      clicks: number;
      conversions: number;
      revenue_cents: number;
      ctr: number;
      cpc_cents: number;
      cpa_cents: number;
      roas: number;
      cvr: number;
      spend_trend_pct: number | null;  // WoW % change
      roas_trend_pct: number | null;
      cpa_trend_pct: number | null;    // WoW CPA change
      cvr_trend_pct: number | null;    // WoW conversion rate change
      efficiency_score: number;         // 0-100 composite score
      daily_spend_cents: number;        // Average daily spend rate
      flags: string[];
      active_days: number;
      // Historical (for paused)
      historical_roas: number | null;
      historical_conversions: number | null;
      last_active_date: string | null;
    }

    const analyzed: CampaignAnalysis[] = [];
    let totalSpendCents = 0;
    let totalRevenueCents = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;

    // Per-platform aggregates
    const platformAgg: Record<string, { spend_cents: number; revenue_cents: number; impressions: number; clicks: number; conversions: number }> = {};

    // Pass 1: Compute totals and platform aggregates (needed for relative flags)
    for (const c of campaigns) {
      totalSpendCents += c.spend_cents;
      totalRevenueCents += c.revenue_cents;
      totalImpressions += c.impressions;
      totalClicks += c.clicks;
      totalConversions += c.conversions;

      if (!platformAgg[c.platform]) {
        platformAgg[c.platform] = { spend_cents: 0, revenue_cents: 0, impressions: 0, clicks: 0, conversions: 0 };
      }
      const pa = platformAgg[c.platform];
      pa.spend_cents += c.spend_cents;
      pa.revenue_cents += c.revenue_cents;
      pa.impressions += c.impressions;
      pa.clicks += c.clicks;
      pa.conversions += c.conversions;
    }

    // Portfolio-level averages for relative comparisons
    // When verified revenue is available, use it for ROAS/CPA averages.
    // Platform-reported revenue is near-zero for most orgs — using it would
    // make every campaign look like it has 0% efficiency.
    const effectiveRevenueCents = hasVerifiedRevenue ? verifiedRevenueCents : totalRevenueCents;
    const effectiveConversions = hasVerifiedRevenue ? verifiedConversions : totalConversions;
    const avgCpa = effectiveConversions > 0 ? totalSpendCents / effectiveConversions : 0;
    const avgRoas = totalSpendCents > 0 ? effectiveRevenueCents / totalSpendCents : 0;
    const medianSpend = (() => {
      const spends = campaigns.filter(c => c.spend_cents > 0).map(c => c.spend_cents).sort((a, b) => a - b);
      if (spends.length === 0) return 0;
      const mid = Math.floor(spends.length / 2);
      return spends.length % 2 ? spends[mid] : (spends[mid - 1] + spends[mid]) / 2;
    })();

    // Pass 2: Compute per-campaign derived metrics, trends, and flags
    for (const c of campaigns) {
      const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
      const cpc_cents = c.clicks > 0 ? Math.round(c.spend_cents / c.clicks) : 0;
      // When verified revenue is available, distribute proportionally by spend for per-campaign ROAS.
      // This is an approximation — the attribution engine provides per-campaign credit, but that
      // data isn't available in the math phase. Spend-share is a reasonable proxy.
      const effectiveCampaignRevenue = hasVerifiedRevenue && totalSpendCents > 0
        ? Math.round(verifiedRevenueCents * (c.spend_cents / totalSpendCents))
        : c.revenue_cents;
      const effectiveCampaignConversions = hasVerifiedRevenue && totalSpendCents > 0
        ? Math.round(verifiedConversions * (c.spend_cents / totalSpendCents))
        : c.conversions;
      const cpa_cents = effectiveCampaignConversions > 0 ? Math.round(c.spend_cents / effectiveCampaignConversions) : 0;
      const roas = c.spend_cents > 0 ? effectiveCampaignRevenue / c.spend_cents : 0;
      const cvr = c.clicks > 0 ? (effectiveCampaignConversions / c.clicks) * 100 : 0;
      const daily_spend_cents = c.active_days > 0 ? Math.round(c.spend_cents / c.active_days) : 0;

      // Trend calculations (WoW change)
      const prior = priorMap.get(c.campaign_uuid);
      const spend_trend_pct = prior && prior.spend_cents > 0
        ? ((c.spend_cents - prior.spend_cents) / prior.spend_cents) * 100
        : null;
      // When using verified revenue, skip ROAS trends — we don't have prior-period verified revenue
      // to compare against, so the comparison would be meaningless.
      const priorRoas = !hasVerifiedRevenue && prior && prior.spend_cents > 0 ? prior.revenue_cents / prior.spend_cents : null;
      const roas_trend_pct = priorRoas !== null && priorRoas > 0
        ? ((roas - priorRoas) / priorRoas) * 100
        : null;
      const cpa_trend_pct = (() => {
        if (!prior || prior.conversions === 0 || c.conversions === 0) return null;
        const priorCpa = prior.spend_cents / prior.conversions;
        return priorCpa > 0 ? ((cpa_cents - priorCpa) / priorCpa) * 100 : null;
      })();
      const cvr_trend_pct = (() => {
        if (!prior || prior.clicks === 0 || c.clicks === 0) return null;
        const priorCvr = (prior.conversions / prior.clicks) * 100;
        return priorCvr > 0 ? ((cvr - priorCvr) / priorCvr) * 100 : null;
      })();

      // Efficiency score: composite 0-100 ranking (higher = better)
      // Weighted: 40% ROAS percentile, 30% CVR percentile, 30% inverse CPA percentile
      // Computed relative to portfolio averages using sigmoid-like clamping
      const efficiency_score = (() => {
        if (c.spend_cents === 0) return 0;
        // ROAS component: score vs portfolio average (0-40 points)
        const roasComponent = avgRoas > 0
          ? Math.min(40, Math.max(0, (roas / avgRoas) * 20))
          : (roas > 0 ? 20 : 0);
        // CVR component: raw CVR capped at 20% = full marks (0-30 points)
        const cvrComponent = Math.min(30, cvr * 3);
        // CPA component: lower is better, inverse ratio vs average (0-30 points)
        const cpaComponent = cpa_cents > 0 && avgCpa > 0
          ? Math.min(30, Math.max(0, (avgCpa / cpa_cents) * 15))
          : (c.conversions > 0 ? 15 : 0);
        return Math.round(roasComponent + cvrComponent + cpaComponent);
      })();

      // Historical for paused campaigns
      const hist = historicalMap.get(c.campaign_uuid);
      const historical_roas = hist && hist.total_spend > 0 ? hist.total_revenue / hist.total_spend : null;
      const historical_conversions = hist ? hist.total_conversions : null;

      // Anomaly flags (uses final portfolio-level averages — no partial-sum bug)
      const flags: string[] = [];
      const isActive = ['ACTIVE', 'ENABLED', 'RUNNING', 'LIVE'].includes((c.campaign_status || '').toUpperCase());

      // Only flag zero_conversions if we don't have verified revenue — with verified revenue,
      // platform-reported conversions being 0 is expected and normal.
      if (c.spend_cents > 0 && effectiveCampaignConversions === 0) flags.push('zero_conversions');
      if (roas > 0 && roas < 1.0) flags.push('unprofitable_roas');
      if (roas >= 1.0 && roas < 1.5) flags.push('low_roas');
      if (cpa_cents > 0 && avgCpa > 0 && cpa_cents > avgCpa * 2) flags.push('high_cpa');
      if (roas_trend_pct !== null && roas_trend_pct < -30) flags.push('declining_roas');
      if (cpa_trend_pct !== null && cpa_trend_pct > 50) flags.push('cpa_increasing');
      if (spend_trend_pct !== null && spend_trend_pct > 50) flags.push('spend_spike');
      // Diminishing returns: spend increasing but ROAS declining — throwing money at diminishing results
      if (spend_trend_pct !== null && spend_trend_pct > 20 && roas_trend_pct !== null && roas_trend_pct < -10) {
        flags.push('diminishing_returns');
      }
      // CVR collapsing: conversion rate dropped >40% WoW — landing page or audience issue
      if (cvr_trend_pct !== null && cvr_trend_pct < -40) flags.push('cvr_declining');
      // Budget concentration: single campaign consuming >40% of total spend
      if (totalSpendCents > 0 && c.spend_cents > totalSpendCents * 0.4) flags.push('high_concentration');
      // Top performer flag for quick identification (skip if portfolio has no revenue)
      if (avgRoas > 0 && roas > avgRoas * 1.5 && c.spend_cents >= medianSpend) flags.push('top_performer');
      if (!isActive && historical_roas !== null && historical_roas > 2.0 && (historical_conversions || 0) > 5) {
        flags.push('paused_strong_history');
      }
      if (!isActive && c.spend_cents === 0) flags.push('paused_no_recent_spend');
      if (isActive && c.spend_cents === 0 && c.active_days === 0) flags.push('active_no_data');

      analyzed.push({
        name: c.campaign_name,
        platform: c.platform,
        status: c.campaign_status,
        spend_cents: c.spend_cents,
        impressions: c.impressions,
        clicks: c.clicks,
        conversions: effectiveCampaignConversions,
        revenue_cents: effectiveCampaignRevenue,
        ctr, cpc_cents, cpa_cents, roas, cvr,
        spend_trend_pct, roas_trend_pct, cpa_trend_pct, cvr_trend_pct,
        efficiency_score, daily_spend_cents,
        flags,
        active_days: c.active_days,
        historical_roas,
        historical_conversions,
        last_active_date: hist?.last_active_date || c.last_active || null
      });
    }

    // ── Format structured output for the agent ──
    // Use verified revenue (from connectors) as primary ROAS when available.
    // Platform-reported revenue is typically near-zero because ad platforms don't
    // know about revenue that happens in Stripe/Shopify/etc.
    const primaryRevenueCents = hasVerifiedRevenue ? verifiedRevenueCents : totalRevenueCents;
    const primaryConversions = hasVerifiedRevenue ? verifiedConversions : totalConversions;
    const trueRoas = totalSpendCents > 0 ? (primaryRevenueCents / totalSpendCents).toFixed(2) : '0.00';

    let summary = `## Portfolio Summary (${days}d)\n`;
    summary += `| Metric | Value |\n|---|---|\n`;
    summary += `| Total Ad Spend | ${fmt(totalSpendCents)} |\n`;
    if (hasVerifiedRevenue) {
      summary += `| Verified Revenue (connectors) | ${fmt(verifiedRevenueCents)} |\n`;
      summary += `| True ROAS | ${trueRoas}x |\n`;
      summary += `| Verified Conversions | ${verifiedConversions.toLocaleString()} |\n`;
      summary += `| True CPA | ${verifiedConversions > 0 ? fmt(Math.round(totalSpendCents / verifiedConversions)) : 'N/A'} |\n`;
      if (totalRevenueCents > 0) {
        summary += `| Platform-Reported Revenue | ${fmt(totalRevenueCents)} (ad platforms only — typically incomplete) |\n`;
      }
    } else {
      summary += `| Platform-Reported Revenue | ${fmt(totalRevenueCents)} |\n`;
      summary += `| Blended ROAS | ${trueRoas}x |\n`;
      summary += `| Platform Conversions | ${totalConversions.toLocaleString()} |\n`;
      summary += `| Blended CPA | ${totalConversions > 0 ? fmt(Math.round(totalSpendCents / totalConversions)) : 'N/A'} |\n`;
    }
    summary += `| Impressions | ${totalImpressions.toLocaleString()} |\n`;
    summary += `| Clicks | ${totalClicks.toLocaleString()} |\n`;
    summary += `| CTR | ${pct(totalClicks, totalImpressions)} |\n`;
    summary += `| CPC | ${totalClicks > 0 ? fmt(Math.round(totalSpendCents / totalClicks)) : 'N/A'} |\n`;
    summary += `| Click-to-Conversion Rate | ${pct(primaryConversions, totalClicks)} |\n`;
    const activeCampaignsCount = analyzed.filter(c => c.spend_cents > 0).length;
    const avgEfficiency = activeCampaignsCount > 0
      ? Math.round(analyzed.filter(c => c.spend_cents > 0).reduce((sum, c) => sum + c.efficiency_score, 0) / activeCampaignsCount)
      : 0;
    const totalDailySpend = analyzed.reduce((sum, c) => sum + c.daily_spend_cents, 0);
    summary += `| Daily Spend Rate | ${fmt(totalDailySpend)} |\n`;
    summary += `| Avg Efficiency | ${avgEfficiency}/100 |\n`;
    summary += `| Active Campaigns | ${activeCampaignsCount}/${campaigns.length} |\n\n`;

    // Per-platform breakdown
    const platformNames = Object.keys(platformAgg);
    if (platformNames.length > 0) {
      summary += `### Per-Platform Breakdown\n`;
      summary += `| Platform | Spend | Revenue | ROAS | CPA | CTR | Conversions |\n|---|---|---|---|---|---|---|\n`;
      for (const p of platformNames) {
        const m = platformAgg[p];
        const pRoas = m.spend_cents > 0 ? (m.revenue_cents / m.spend_cents).toFixed(2) + 'x' : 'N/A';
        const pCpa = m.conversions > 0 ? fmt(Math.round(m.spend_cents / m.conversions)) : 'N/A';
        const pCtr = pct(m.clicks, m.impressions);
        const share = totalSpendCents > 0 ? ` (${(m.spend_cents / totalSpendCents * 100).toFixed(0)}%)` : '';
        summary += `| ${p.charAt(0).toUpperCase() + p.slice(1)} | ${fmt(m.spend_cents)}${share} | ${fmt(m.revenue_cents)} | ${pRoas} | ${pCpa} | ${pCtr} | ${m.conversions.toLocaleString()} |\n`;
      }
      summary += '\n';
    }

    // Top performers (by efficiency score, minimum $1 spend)
    const withSpend = analyzed.filter(c => c.spend_cents >= 100); // $1 minimum
    const topByEfficiency = [...withSpend].sort((a, b) => b.efficiency_score - a.efficiency_score).slice(0, 10);
    if (topByEfficiency.length > 0) {
      summary += `### Top Performers (by Efficiency Score)\n`;
      summary += `| Campaign | Platform | Eff. | Spend | $/day | ROAS | CPA | CVR | Trend |\n|---|---|---|---|---|---|---|---|---|\n`;
      for (const c of topByEfficiency) {
        const trend = c.roas_trend_pct !== null ? `${c.roas_trend_pct > 0 ? '+' : ''}${c.roas_trend_pct.toFixed(0)}%` : '—';
        summary += `| ${c.name} | ${c.platform} | ${c.efficiency_score} | ${fmt(c.spend_cents)} | ${fmt(c.daily_spend_cents)} | ${c.roas.toFixed(2)}x | ${fmt(c.cpa_cents)} | ${c.cvr.toFixed(1)}% | ${trend} |\n`;
      }
      summary += '\n';
    }

    // Underperformers (low ROAS or zero conversions, with spend)
    const underperformers = withSpend
      .filter(c => c.flags.some(f => ['zero_conversions', 'unprofitable_roas', 'low_roas', 'high_cpa'].includes(f)))
      .sort((a, b) => a.roas - b.roas)
      .slice(0, 10);
    if (underperformers.length > 0) {
      summary += `### Underperformers\n`;
      summary += `| Campaign | Platform | Status | Spend | ROAS | CPA | Flags |\n|---|---|---|---|---|---|---|\n`;
      for (const c of underperformers) {
        summary += `| ${c.name} | ${c.platform} | ${c.status} | ${fmt(c.spend_cents)} | ${c.roas.toFixed(2)}x | ${c.cpa_cents > 0 ? fmt(c.cpa_cents) : 'N/A'} | ${c.flags.join(', ')} |\n`;
      }
      summary += '\n';
    }

    // Paused campaigns with strong historical performance
    const pausedOpportunities = analyzed
      .filter(c => c.flags.includes('paused_strong_history'))
      .sort((a, b) => (b.historical_roas || 0) - (a.historical_roas || 0))
      .slice(0, 5);
    if (pausedOpportunities.length > 0) {
      summary += `### Paused — Relaunch Candidates\n`;
      summary += `| Campaign | Platform | Historical ROAS | Historical Conversions | Last Active |\n|---|---|---|---|---|\n`;
      for (const c of pausedOpportunities) {
        summary += `| ${c.name} | ${c.platform} | ${c.historical_roas?.toFixed(2)}x | ${c.historical_conversions} | ${c.last_active_date || 'unknown'} |\n`;
      }
      summary += '\n';
    }

    // Trend alerts (includes all trend-based flags)
    const trendFlags = ['declining_roas', 'spend_spike', 'cpa_increasing', 'high_concentration', 'diminishing_returns', 'cvr_declining'];
    const trendAlerts = analyzed.filter(c => c.flags.some(f => trendFlags.includes(f)));
    if (trendAlerts.length > 0) {
      summary += `### Trend Alerts\n`;
      for (const c of trendAlerts) {
        const parts: string[] = [];
        if (c.flags.includes('diminishing_returns')) parts.push(`DIMINISHING RETURNS: spend up ${c.spend_trend_pct?.toFixed(0)}% but ROAS down ${c.roas_trend_pct?.toFixed(0)}%`);
        if (c.flags.includes('declining_roas')) parts.push(`ROAS declining ${c.roas_trend_pct?.toFixed(0)}%`);
        if (c.flags.includes('cvr_declining')) parts.push(`CVR dropping ${c.cvr_trend_pct?.toFixed(0)}% WoW`);
        if (c.flags.includes('cpa_increasing')) parts.push(`CPA up ${c.cpa_trend_pct?.toFixed(0)}% WoW`);
        if (c.flags.includes('spend_spike')) parts.push(`spend up ${c.spend_trend_pct?.toFixed(0)}%`);
        if (c.flags.includes('high_concentration')) {
          const share = totalSpendCents > 0 ? Math.round(c.spend_cents / totalSpendCents * 100) : 0;
          parts.push(`${share}% of total spend (concentration risk)`);
        }
        summary += `- **${c.name}** (${c.platform}): ${parts.join(', ')} — ${c.roas.toFixed(2)}x ROAS, ${fmt(c.daily_spend_cents)}/day, efficiency ${c.efficiency_score}/100\n`;
      }
      summary += '\n';
    }

    // Build platform summaries (per-platform campaign listings for the agent)
    const platformSummaries: Record<string, string> = {};
    for (const p of platformNames) {
      const pCampaigns = analyzed.filter(c => c.platform === p && c.spend_cents > 0);
      if (pCampaigns.length === 0) continue;
      let ps = `${pCampaigns.length} active campaigns, ${fmt(platformAgg[p].spend_cents)} total spend\n`;
      ps += `Top campaign: ${pCampaigns[0].name} (${pCampaigns[0].roas.toFixed(2)}x ROAS, ${fmt(pCampaigns[0].spend_cents)} spend)\n`;
      if (pCampaigns.length > 1) {
        const worst = pCampaigns[pCampaigns.length - 1];
        ps += `Weakest: ${worst.name} (${worst.roas.toFixed(2)}x ROAS, ${fmt(worst.spend_cents)} spend)`;
      }
      platformSummaries[p] = ps;
    }

    // ── Additional context (journeys, CAC, revenue sources — unchanged from v1) ──
    let additionalContext = summary;

    try {
      const orgTagRow = await this.env.DB.prepare(
        'SELECT short_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1'
      ).bind(orgId).first<{ short_tag: string }>();
      const orgTag = orgTagRow?.short_tag;

      if (orgTag) {
        // Journey analytics
        try {
          const journey = await this.env.ANALYTICS_DB.prepare(`
            SELECT total_sessions, converting_sessions, conversion_rate,
                   avg_path_length, channel_distribution
            FROM journey_analytics
            WHERE org_tag = ?
            ORDER BY computed_at DESC LIMIT 1
          `).bind(orgTag).first<{
            total_sessions: number;
            converting_sessions: number;
            conversion_rate: number;
            avg_path_length: number;
            channel_distribution: string | null;
          }>();

          if (journey && journey.total_sessions > 0) {
            const channels = journey.channel_distribution ? JSON.parse(journey.channel_distribution) : {};
            const topChannels = Object.entries(channels)
              .sort((a: any, b: any) => b[1] - a[1])
              .slice(0, 5)
              .map(([ch, cnt]) => `${ch}: ${cnt} sessions`)
              .join(', ');

            additionalContext += `## Journey Analytics\n`;
            additionalContext += `- Total sessions: ${journey.total_sessions.toLocaleString()}\n`;
            additionalContext += `- Converting sessions: ${journey.converting_sessions.toLocaleString()} (${journey.conversion_rate}%)\n`;
            additionalContext += `- Avg path length: ${journey.avg_path_length}\n`;
            if (topChannels) additionalContext += `- Top channels: ${topChannels}\n`;
            additionalContext += '\n';
          }
        } catch { /* journey_analytics may not exist */ }

        // Page Flow Insights
        try {
          const topConvertingPages = await this.env.ANALYTICS_DB.prepare(`
            SELECT to_id as page,
                   SUM(visitors_transitioned) as visitors,
                   SUM(conversions) as conversions,
                   SUM(revenue_cents) as revenue_cents
            FROM funnel_transitions
            WHERE org_tag = ? AND from_type = 'page_url' AND conversions > 0
              AND period_start >= date('now', '-' || ? || ' days')
            GROUP BY to_id ORDER BY conversions DESC LIMIT 5
          `).bind(orgTag, days).all<{
            page: string; visitors: number; conversions: number; revenue_cents: number;
          }>();

          const dropoffPages = await this.env.ANALYTICS_DB.prepare(`
            SELECT from_id as page,
                   SUM(daily_visitors) as entering,
                   SUM(daily_leaving) as leaving
            FROM (
              SELECT from_id, period_start,
                     MAX(visitors_at_from) as daily_visitors,
                     SUM(visitors_transitioned) as daily_leaving
              FROM funnel_transitions
              WHERE org_tag = ? AND from_type = 'page_url' AND to_type = 'page_url'
                AND period_start >= date('now', '-' || ? || ' days')
              GROUP BY from_id, period_start
            ) GROUP BY from_id
            HAVING entering >= 10
            ORDER BY CAST(entering - leaving AS REAL) / entering DESC
            LIMIT 5
          `).bind(orgTag, days).all<{
            page: string; entering: number; leaving: number;
          }>();

          const convertingPages = topConvertingPages.results || [];
          const dropoffs = dropoffPages.results || [];

          if (convertingPages.length > 0 || dropoffs.length > 0) {
            additionalContext += `## Page Flow Insights (${days}d)\n`;
            if (convertingPages.length > 0) {
              additionalContext += '### Top Converting Pages\n';
              for (const p of convertingPages) {
                additionalContext += `- ${p.page}: ${p.conversions} conversions, ${p.visitors} visitors (${fmt(p.revenue_cents)} revenue)\n`;
              }
            }
            if (dropoffs.length > 0) {
              additionalContext += '### Highest Dropoff Pages\n';
              for (const p of dropoffs) {
                const dropoff = p.entering - p.leaving;
                const rate = p.entering > 0 ? Math.round((dropoff / p.entering) * 100) : 0;
                additionalContext += `- ${p.page}: ${dropoff} visitors lost (${rate}% dropoff, ${p.entering} entered → ${p.leaving} continued)\n`;
              }
            }
            additionalContext += '\n';
          }
        } catch { /* funnel_transitions may not have data */ }

        // Daily traffic
        try {
          const traffic = await this.env.ANALYTICS_DB.prepare(`
            SELECT SUM(sessions) as sessions, SUM(users) as users,
                   SUM(conversions) as conversions, SUM(revenue_cents) as revenue_cents
            FROM daily_metrics
            WHERE org_tag = ?
              AND date >= date('now', '-' || ? || ' days')
          `).bind(orgTag, days).first<{
            sessions: number | null; users: number | null; conversions: number | null; revenue_cents: number | null;
          }>();

          if (traffic && (traffic.sessions || 0) > 0) {
            additionalContext += `## Site Traffic (${days}d)\n`;
            additionalContext += `- Sessions: ${(traffic.sessions || 0).toLocaleString()}\n`;
            additionalContext += `- Unique users: ${(traffic.users || 0).toLocaleString()}\n`;
            additionalContext += `- Conversions: ${(traffic.conversions || 0).toLocaleString()}\n`;
            additionalContext += `- Revenue: ${fmt(traffic.revenue_cents || 0)}\n`;
            additionalContext += `- Site conv. rate: ${pct(traffic.conversions || 0, traffic.sessions || 0)}\n`;
            if (totalSpendCents > 0 && (traffic.sessions || 0) > 0) {
              additionalContext += `- Cost per session: ${fmt(Math.round(totalSpendCents / (traffic.sessions || 1)))}\n`;
            }
            additionalContext += '\n';
          }
        } catch { /* daily_metrics may not exist */ }
      }

      // CAC trend
      try {
        const cacRows = await this.env.ANALYTICS_DB.prepare(`
          SELECT date, cac_cents FROM cac_history
          WHERE organization_id = ?
          ORDER BY date DESC LIMIT 14
        `).bind(orgId).all<{ date: string; cac_cents: number }>();

        const cacHistory = cacRows.results || [];
        if (cacHistory.length > 0) {
          const current = cacHistory[0].cac_cents;
          const oldest = cacHistory[cacHistory.length - 1].cac_cents;
          const trendPct = oldest > 0 ? Math.round(((current - oldest) / oldest) * 100) : 0;
          const values = cacHistory.map(h => h.cac_cents);
          const minCac = Math.min(...values);
          const maxCac = Math.max(...values);

          additionalContext += `## CAC Trend (14d)\n`;
          additionalContext += `- Current CAC: ${fmt(current)}\n`;
          additionalContext += `- Trend: ${trendPct > 0 ? '+' : ''}${trendPct}% over ${cacHistory.length} days\n`;
          additionalContext += `- Range: ${fmt(minCac)} – ${fmt(maxCac)}\n`;
          if (totalConversions > 0) {
            const platformCpa = Math.round(totalSpendCents / totalConversions);
            const delta = current > 0 ? Math.round(((platformCpa - current) / current) * 100) : 0;
            additionalContext += `- Platform CPA vs tracked CAC: ${fmt(platformCpa)} vs ${fmt(current)} (${delta > 0 ? '+' : ''}${delta}%)\n`;
          }
          additionalContext += '\n';
        }
      } catch { /* cac_history may not exist */ }

      // Shopify revenue
      try {
        const shopify = await this.env.ANALYTICS_DB.prepare(`
          SELECT COUNT(*) as orders, COALESCE(SUM(value_cents), 0) as revenue_cents,
                 AVG(value_cents) as aov_cents,
                 COUNT(DISTINCT customer_external_id) as unique_customers
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform = 'shopify'
            AND transacted_at >= date('now', '-' || ? || ' days')
            AND status IN ('succeeded', 'paid', 'completed', 'active')
        `).bind(orgId, days).first<{
          orders: number; revenue_cents: number | null; aov_cents: number | null; unique_customers: number;
        }>();

        if (shopify && (shopify.orders || 0) > 0) {
          additionalContext += `## Shopify Revenue (${days}d)\n`;
          additionalContext += `- Orders: ${shopify.orders.toLocaleString()}\n`;
          additionalContext += `- Revenue: ${fmt(shopify.revenue_cents || 0)}\n`;
          additionalContext += `- AOV: ${fmt(Math.round(shopify.aov_cents || 0))}\n`;
          additionalContext += `- Unique customers: ${shopify.unique_customers}\n`;
          if (totalSpendCents > 0 && shopify.revenue_cents) {
            additionalContext += `- Shopify ROAS: ${(shopify.revenue_cents / totalSpendCents).toFixed(2)}x\n`;
          }
          additionalContext += '\n';
        }
      } catch { /* connector_events query failed */ }

      // CRM pipeline
      try {
        const crm = await this.env.ANALYTICS_DB.prepare(`
          SELECT COUNT(*) as deals,
                 COUNT(CASE WHEN status = 'closedwon' THEN 1 END) as won,
                 COUNT(CASE WHEN status = 'closedlost' THEN 1 END) as lost,
                 SUM(value_cents) as pipeline_cents,
                 SUM(CASE WHEN status = 'closedwon' THEN value_cents ELSE 0 END) as won_cents
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform = 'hubspot' AND event_type = 'deal'
            AND transacted_at >= date('now', '-' || ? || ' days')
        `).bind(orgId, days).first<{
          deals: number; won: number; lost: number;
          pipeline_cents: number | null; won_cents: number | null;
        }>();

        if (crm && (crm.deals || 0) > 0) {
          additionalContext += `## CRM Pipeline (${days}d)\n`;
          additionalContext += `- Total deals: ${crm.deals} (${crm.won} won, ${crm.lost} lost)\n`;
          additionalContext += `- Pipeline value: ${fmt(crm.pipeline_cents || 0)}\n`;
          additionalContext += `- Won value: ${fmt(crm.won_cents || 0)}\n`;
          const winRate = (crm.won + crm.lost) > 0 ? Math.round(crm.won / (crm.won + crm.lost) * 100) : 0;
          additionalContext += `- Win rate: ${winRate}%\n\n`;
        }
      } catch { /* connector_events deal query failed */ }

      // Subscription activity
      try {
        const subs = await this.env.ANALYTICS_DB.prepare(`
          SELECT COUNT(*) as total,
                 COUNT(CASE WHEN status IN ('active', 'trialing') THEN 1 END) as active,
                 COUNT(CASE WHEN status IN ('canceled', 'cancelled') THEN 1 END) as canceled,
                 COALESCE(SUM(CASE WHEN status IN ('active', 'trialing') THEN value_cents ELSE 0 END), 0) as mrr_cents
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform = 'stripe'
            AND event_type LIKE '%subscription%'
        `).bind(orgId).first<{
          total: number; active: number; canceled: number; mrr_cents: number | null;
        }>();

        if (subs && (subs.total || 0) > 0) {
          const mrrCents = subs.mrr_cents || 0;
          additionalContext += `## Subscriptions\n`;
          additionalContext += `- Active: ${subs.active} | Canceled: ${subs.canceled} | Total: ${subs.total}\n`;
          additionalContext += `- MRR: ${fmt(mrrCents)} | ARR: ${fmt(mrrCents * 12)}\n`;
          const churnRate = subs.total > 0 ? Math.round(subs.canceled / subs.total * 100) : 0;
          additionalContext += `- Churn rate: ${churnRate}%\n\n`;
        }
      } catch { /* connector_events subscription query failed */ }

      // Email/SMS engagement
      try {
        const comms = await this.env.ANALYTICS_DB.prepare(`
          SELECT event_type, COUNT(*) as count
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform IN ('sendgrid', 'attentive', 'mailchimp', 'tracking_link')
            AND transacted_at >= date('now', '-' || ? || ' days')
          GROUP BY event_type
        `).bind(orgId, days).all<{ event_type: string; count: number }>();

        const engMap: Record<string, number> = {};
        for (const r of comms.results || []) {
          engMap[r.event_type] = r.count;
        }

        const sent = (engMap['email_sent'] || 0) + (engMap['sms_sent'] || 0);
        const opens = engMap['email_open'] || 0;
        const emailClicks = (engMap['email_click'] || 0) + (engMap['sms_click'] || 0) + (engMap['link_click'] || 0);

        if (Object.keys(engMap).length > 0) {
          additionalContext += `## Email/SMS (${days}d)\n`;
          additionalContext += `- Sent: ${sent.toLocaleString()}\n`;
          additionalContext += `- Opens: ${opens.toLocaleString()} (${sent > 0 ? (opens / sent * 100).toFixed(1) : '0'}%)\n`;
          additionalContext += `- Clicks: ${emailClicks.toLocaleString()} (${sent > 0 ? (emailClicks / sent * 100).toFixed(1) : '0'}%)\n\n`;
        }
      } catch { /* connector_events comm query failed */ }

    } catch {
      // Non-critical — additional context is best-effort
    }

    // Log entity completions for dashboard tree (mark all campaigns as "processed" for visualization)
    const activeCampaigns = analyzed.filter(c => c.spend_cents > 0);
    for (const c of activeCampaigns) {
      try {
        await this.env.DB.prepare(
          `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'entity_complete', NULL, ?, ?)`
        ).bind(jobId, orgId, c.name, `${c.platform}:campaign`).run();
      } catch (e) { /* non-critical */ }
    }

    const totalEntities = activeCampaigns.length;
    await jobs.updateProgress(jobId, totalEntities, 'cross_platform');

    console.log(`[Analysis] Portfolio analysis complete: ${campaigns.length} campaigns analyzed (${activeCampaigns.length} active, ${campaigns.length - activeCampaigns.length} inactive) via SQL — 0 LLM calls`);

    return {
      crossPlatformSummary: summary,
      platformSummaries,
      processedCount: totalEntities + 1,
      additionalContext
    };
  }


  /**
   * Fetch recent recommendations to avoid repetition
   */
  private async getRecentRecommendations(
    orgId: string,
    lookbackDays: number = 30
  ): Promise<Array<{ action: string; parameters: string; reason: string; status: string; days_ago: number }>> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

    try {
      const result = await this.env.DB.prepare(`
        SELECT
          tool,
          parameters,
          reason,
          status,
          CAST(julianday('now') - julianday(reviewed_at) AS INTEGER) as days_ago
        FROM ai_decisions
        WHERE organization_id = ?
          AND status IN ('approved', 'rejected')
          AND reviewed_at >= ?
        ORDER BY reviewed_at DESC
        LIMIT 30
      `).bind(orgId, cutoffDate.toISOString()).all<{
        tool: string;
        parameters: string;
        reason: string;
        status: string;
        days_ago: number;
      }>();

      return (result.results || []).map(r => ({
        action: r.tool,
        parameters: r.parameters,
        reason: r.reason,
        status: r.status,
        days_ago: r.days_ago
      }));
    } catch {
      return [];
    }
  }

  /**
   * Build context prompt for agentic loop
   */
  private buildAgenticContextPrompt(
    executiveSummary: string,
    platformSummaries: Record<string, string>,
    additionalContext?: string
  ): string {
    let prompt = `## Executive Summary\n${executiveSummary}\n\n`;
    prompt += '## Platform Summaries\n';
    for (const [platform, summary] of Object.entries(platformSummaries)) {
      prompt += `### ${platform.charAt(0).toUpperCase() + platform.slice(1)}\n${summary}\n\n`;
    }
    if (additionalContext) {
      prompt += additionalContext + '\n\n';
    }
    prompt += `Based on the analysis above:
1. FIRST: Explore the data using query tools to find actionable opportunities
2. THEN: Generate up to 3 action recommendations using set_budget, set_status, set_audience, or reallocate_budget (run simulate_change first for budget/status changes)
3. OPTIONALLY: Use general_insight ONLY for observations that cannot be expressed as actions
4. FINALLY: Call terminate_analysis when complete

Prioritize concrete actions over observations. Insights are a fallback for things that don't fit the action tools.`;
    return prompt;
  }

  /**
   * Build system prompt for agentic loop
   */
  private buildAgenticSystemPrompt(
    days: number,
    customInstructions: string | null,
    recentRecs: Array<{ action: string; parameters: string; reason: string; status: string; days_ago: number }>,
    config?: AnalysisWorkflowParams['config']
  ): string {
    const budgetStrategy = config?.budgetStrategy || 'moderate';
    const dailyCapCents = config?.dailyCapCents;
    const monthlyCapCents = config?.monthlyCapCents;
    const maxCacCents = config?.maxCacCents;

    let systemPrompt = `You are an expert digital advertising strategist. Based on the analysis provided, identify actionable optimizations.

IMPORTANT DATE RANGE: This analysis covers the LAST ${days} DAYS only.

IMPORTANT DATA UNITS: All monetary values in raw data are in CENTS (not dollars).

CRITICAL - BUDGET vs SPEND:
- BUDGET is the configured limit
- SPEND is what was actually spent
- ALWAYS use get_entity_budget to check actual budget before recommending changes.

CRITICAL - PLATFORM-REPORTED vs VERIFIED REVENUE:
AdBliss exists to solve the attribution gap between ad platforms and payment processors. This is the core value proposition — NOT a bug or tracking issue.
- **Platform-reported revenue** (from Google/Meta/TikTok) is almost always near-zero or grossly inaccurate because ad platforms cannot track conversions that happen in external systems (Stripe checkout, Shopify cart, etc.)
- **Verified revenue** (from Stripe, Shopify, Jobber, etc.) is the ground truth — this is real money collected by the business
- A large gap between platform-reported and verified revenue is EXPECTED and NORMAL — it means the user's revenue flows through a payment processor that doesn't feed data back to ad platforms
- The "True ROAS" in the portfolio summary uses verified revenue and IS the correct metric for decision-making
- NEVER flag the platform vs verified discrepancy as a problem, tracking issue, or configuration error
- NEVER recommend "fixing conversion tracking" or "passing value back to ad platforms" — the whole point of AdBliss is that this isn't possible or practical for most businesses
- When computing efficiency, ROAS, and CPA, always prefer verified/true metrics over platform-reported ones
- An "efficiency score" based on platform-reported ROAS will be misleadingly low — use verified ROAS for real performance assessment

## SPENDING LIMITS (HARD CAPS — NEVER EXCEED)
${dailyCapCents ? `- Daily spend cap: $${(dailyCapCents / 100).toFixed(2)}` : '- No daily cap set'}
${monthlyCapCents ? `- Monthly spend cap: $${(monthlyCapCents / 100).toFixed(2)}` : '- No monthly cap set'}
${maxCacCents ? `- CAC ceiling: $${(maxCacCents / 100).toFixed(2)} — do NOT recommend changes that would push blended CAC above this` : '- No CAC ceiling set'}
All recommendations MUST keep projected spend and CAC within these limits. If a recommendation would breach a limit, do not make it.

${budgetStrategy === 'conservative' ? `## BUDGET STRATEGY: CONSERVATIVE — Cut waste, protect margins
Your goal is to REDUCE or MAINTAIN current total spend.
NEVER recommend:
- Re-enabling paused campaigns
- Increasing any entity's budget
ALWAYS recommend:
- Pausing underperforming entities to save spend
- Decreasing budgets on low-ROAS entities
- Reallocating budget FROM wasteful entities TO efficient ones (net spend must decrease or stay flat)
` : budgetStrategy === 'aggressive' ? `## BUDGET STRATEGY: AGGRESSIVE — Invest to grow
You are authorized to recommend INCREASING total spend where data supports growth.
DO recommend:
- Re-enabling promising paused campaigns with strong historical ROAS
- Increasing budgets on high-performing entities (up to 30% increase per entity)
- Scaling into new opportunities with projected positive ROAS
Still require simulation backing for all recommendations — no guessing.
` : `## BUDGET STRATEGY: MODERATE — Reallocate for efficiency
Your goal is to MAINTAIN total spend while improving results. Net budget change across all recommendations should be approximately zero.
DO recommend:
- Reallocating budget from underperformers to top performers (budget-neutral swaps)
- Pausing wasteful entities and redistributing their budget to winners
- Re-enabling a paused campaign ONLY if you simultaneously cut an equal amount elsewhere
DO NOT recommend:
- Net increases to total portfolio spend
`}
## OUTPUT STRUCTURE (PRIORITY ORDER)
Your PRIMARY goal is to produce **action recommendations** — concrete, executable changes the user can accept or reject.

1. **Up to 3 action recommendations** (PRIORITIZE) — Use set_budget, set_status, set_audience, or reallocate_budget. Try hard to generate at least ONE action even in difficult conditions (e.g. pausing wasteful entities, reallocating from low to high performers, adjusting budgets based on trends).
2. **Insights** (SECONDARY, OPTIONAL) — Use general_insight ONLY for observations that genuinely cannot be expressed as an action tool call. Examples: data quality gaps, missing tracking, cross-platform patterns. Do NOT use insights as a substitute for action recommendations.

## ACTION RECOMMENDATIONS
Actions are the primary output. Users see these as accept/reject cards:
1. ALWAYS prefer action tools over general_insight — if something can be an action, make it an action
2. Focus on the most impactful changes first
3. For budget changes, stay within 30% of current values
4. For pausing: recommend for entities with poor ROAS (<1.5), high CPA, or declining trends
5. Be specific about entities — use their actual IDs and names
6. Even with limited data, look for: inactive entities to pause, budget reallocation opportunities, underperforming campaigns

## PAUSED CAMPAIGNS — RELAUNCH OPPORTUNITIES
${budgetStrategy === 'conservative' ? `IMPORTANT: Under CONSERVATIVE budget strategy, do NOT recommend re-enabling any paused campaigns. Focus only on pausing and cutting spend.` : `Entities that were previously active but are now paused (no recent spend) are included in the portfolio data.
- Look for paused campaigns/adsets with strong historical performance (good ROAS, reasonable CPA)
- Use simulate_change with action='enable' to model the impact of re-enabling them
- Use set_status with recommended_status='ENABLED' to recommend re-enabling promising paused entities
- Consider recommending budget adjustments alongside re-enabling (e.g. start at lower budget to test)
- If an entity was paused for poor performance, do NOT recommend re-enabling without a strategy change (audience, bid, creative)
- This is a key value-add: identifying dormant campaigns that could drive growth if reactivated`}

## INSIGHT GUIDELINES
Insights are a fallback for non-actionable observations, NOT the main output:
- Use sparingly — only for things that genuinely cannot be an action
- Keep them concise — one insight call with a clear title is usually sufficient
- If you must use multiple insight calls, they accumulate into a single document

## CRITICAL: SIMULATION REQUIRED FOR SET_BUDGET AND SET_STATUS
Before using set_budget or set_status, you MUST first call simulate_change to get the REAL mathematical impact:

1. Call simulate_change with the action (pause/enable/increase_budget/decrease_budget), entity_type, and entity_id
2. Review the simulation results showing ACTUAL CAC impact calculated from historical data
3. If the simulation supports your recommendation (CAC improves or tradeoff is acceptable), call set_budget/set_status
4. The system will REJECT recommendations without simulation - it will auto-run the simulation and ask you to review

DO NOT GUESS impact percentages. The simulation calculates them mathematically using:
- For pause/enable: Simple subtraction/addition of entity's spend and conversions
- For budget changes: Diminishing returns model fitted to historical efficiency data

The simulation result will show you the EXACT impact and you must acknowledge it before proceeding.

## TOOL BEHAVIOR
- simulate_change: Use BEFORE set_budget or set_status. Calculates real mathematical impact. Free to call multiple times.
- general_insight: OPTIONAL fallback. All calls ACCUMULATE into a single document. Does NOT count toward your 3 action recommendation limit.
- set_budget/set_status: REQUIRE simulation first. Up to 3 total action recommendations allowed.
- set_audience/reallocate_budget: Up to 3 total action recommendations allowed.
- terminate_analysis: Call this when you have made action recommendations or exhausted all possibilities. Provide a clear reason.

## EFFICIENCY: CALL MULTIPLE TOOLS PER TURN
You can call multiple tools in a SINGLE response. This is critical for performance:
- Call multiple exploration/query tools at once when investigating different entities or metrics
- Call simulate_change for multiple entities in one turn
- Example: instead of querying campaign A, then campaign B, then campaign C in 3 turns, query all 3 in one turn
- Each turn has overhead — minimize turns by batching independent tool calls together

## WHEN TO USE terminate_analysis
1. You have made action recommendations and addressed major opportunities
2. Data quality prevents meaningful analysis — explain WHY in the reason field (this is shown to users)
3. All entities are performing within expected parameters
4. Continuing would produce low-confidence or repetitive suggestions

The terminate_analysis reason is displayed to users as an explanation, so write it as a clear, helpful summary of what was found and why (or why not) actions were recommended.`;

    if (customInstructions?.trim()) {
      systemPrompt += `\n\n## CUSTOM BUSINESS CONTEXT\n${customInstructions.trim()}`;
    }

    // Add recent recommendation history
    const accepted = recentRecs.filter(r => r.status === 'accepted');
    const rejected = recentRecs.filter(r => r.status === 'rejected');

    if (accepted.length > 0 || rejected.length > 0) {
      systemPrompt += '\n\n## RECENT RECOMMENDATION HISTORY';
      if (accepted.length > 0) {
        systemPrompt += '\n\n### IMPLEMENTED (do not recommend similar):';
        for (const r of accepted) {
          systemPrompt += `\n- ${r.action} - ${r.days_ago} days ago`;
        }
      }
      if (rejected.length > 0) {
        systemPrompt += '\n\n### REJECTED BY USER (avoid similar):';
        for (const r of rejected) {
          systemPrompt += `\n- ${r.action} - ${r.days_ago} days ago`;
        }
      }
    }

    return systemPrompt;
  }

  /**
   * Run a single agentic iteration
   */
  private async runAgenticIteration(
    orgId: string,
    runId: string,
    jobId: string,
    iteration: number,
    messages: any[],
    systemPrompt: string,
    existingRecommendations: Recommendation[],
    existingActionRecommendations: Recommendation[],
    maxActionRecommendations: number,
    enableExploration: boolean,
    existingAccumulatedInsightId: string | null,
    existingAccumulatedInsights: AccumulatedInsightData[],
    existingHasInsight: boolean,
    simulationCache: SimulationCache,  // Shared across iterations for simulation enforcement
    client: AgenticClient
  ): Promise<AgenticIterationResult> {
    // Clone accumulated insights array to avoid mutation
    let accumulatedInsightId = existingAccumulatedInsightId;
    let accumulatedInsights = [...existingAccumulatedInsights];
    const actionRecommendations = [...existingActionRecommendations];
    const explorationExecutor = new ExplorationToolExecutor(this.env.ANALYTICS_DB, this.env.DB);

    // Build tools list with simulate_change at the front
    // Dynamic filtering: only include exploration tools relevant to this org's connectors
    const explorationTools = enableExploration
      ? await getExplorationToolsForOrg(this.env.ANALYTICS_DB, orgId)
      : [];
    const liveApiTools = enableExploration ? [QUERY_API_TOOL] : [];
    const baseTools = [...getToolDefinitions(), ...explorationTools, ...liveApiTools] as AgenticToolDef[];
    const tools = getToolsWithSimulationGeneric(baseTools) as AgenticToolDef[];

    // Determine if this is likely an exploration-heavy turn (no action recs yet)
    // Use low thinking for exploration to reduce latency
    const callOptions: AgenticCallOptions = actionRecommendations.length === 0
      ? { thinkingLevel: 'low' }
      : {};

    // Call LLM via provider-agnostic client
    const callResult = await client.call(messages, systemPrompt, tools, 2048, callOptions);

    // If no tool calls, we're done
    if (callResult.toolCalls.length === 0) {
      return {
        messages,
        recommendations: existingRecommendations,
        shouldStop: true,
        stopReason: 'no_tool_calls',
        accumulatedInsightId: accumulatedInsightId || undefined,
        accumulatedInsights,
        toolCallNames: [],
        inputTokens: callResult.inputTokens,
        outputTokens: callResult.outputTokens
      };
    }

    // Add assistant response (provider-specific format preserved)
    const updatedMessages = [...messages, client.buildAssistantMessage(callResult.rawAssistantMessage)];

    // Process tool calls
    const toolResults: AgenticToolResult[] = [];
    const recommendations = [...existingRecommendations];
    let hitMaxActionRecommendations = false;

    // Helper to log tool call events to analysis_events table (fire-and-forget, non-blocking)
    const logEvent = async (toolName: string, summary: string, status: string, toolInput?: any, toolOutput?: any) => {
      try {
        const inputJson = toolInput ? JSON.stringify(toolInput) : null;
        const outputJson = toolOutput ? JSON.stringify(toolOutput) : null;
        await this.env.DB.prepare(
          `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status, tool_input, tool_output) VALUES (?, ?, ?, 'tool_call', ?, ?, ?, ?, ?)`
        ).bind(jobId, orgId, iteration, toolName, summary, status, inputJson, outputJson).run();
      } catch (e) {
        // Non-critical — don't fail the iteration if event logging fails
        console.error('[Analysis] Failed to log event:', e);
      }
    };

    // ── Partition tool calls into parallel-safe vs sequential ──
    // Parallel-safe: exploration tools, simulate_change, query_api (read-only, no state mutation)
    // Sequential: terminate_analysis, general_insight (accumulates state), recommendation tools (write to DB)
    const parallelSafe: typeof callResult.toolCalls = [];
    const sequential: typeof callResult.toolCalls = [];

    for (const toolCall of callResult.toolCalls) {
      if (isExplorationTool(toolCall.name) || toolCall.name === 'simulate_change' || toolCall.name === 'query_api') {
        parallelSafe.push(toolCall);
      } else {
        sequential.push(toolCall);
      }
    }

    // Execute all parallel-safe tools concurrently
    if (parallelSafe.length > 0) {
      const parallelResults = await Promise.all(parallelSafe.map(async (toolCall) => {
        if (isExplorationTool(toolCall.name)) {
          const exploreResult = await explorationExecutor.execute(toolCall.name, toolCall.input, orgId);
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged', toolCall.input, exploreResult);
          return { toolCallId: toolCall.id, name: toolCall.name, content: exploreResult } as AgenticToolResult;
        }

        if (toolCall.name === 'query_api') {
          const liveApi = new LiveApiExecutor(this.env.DB, this.env);
          const liveResult = await liveApi.execute(toolCall.input as any, orgId);
          await logEvent(toolCall.name, summarizeToolInput(toolCall), liveResult.success ? 'logged' : 'error', toolCall.input, liveResult);
          return { toolCallId: toolCall.id, name: toolCall.name, content: liveResult } as AgenticToolResult;
        }

        if (toolCall.name === 'simulate_change') {
          const simContext: ToolExecutionContext = {
            orgId,
            analysisRunId: runId,
            analyticsDb: this.env.ANALYTICS_DB,
            aiDb: this.env.DB,
            simulationCache
          };
          const simResult = await executeSimulateChange(toolCall.input as any, simContext);
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged', toolCall.input, { success: simResult.success, message: simResult.message, data: simResult.data });
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: { success: simResult.success, message: simResult.message, data: simResult.data }
          } as AgenticToolResult;
        }

        // Shouldn't reach here, but handle gracefully
        return { toolCallId: toolCall.id, name: toolCall.name, content: { status: 'unknown_tool' } } as AgenticToolResult;
      }));

      toolResults.push(...parallelResults);
    }

    // Execute sequential tools in order (these mutate state or have control flow effects)
    for (const toolCall of sequential) {
      // Handle terminate_analysis (control tool)
      if (isTerminateAnalysisTool(toolCall.name)) {
        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: { status: 'terminating', message: 'Analysis terminated by AI decision' }
        });

        await logEvent(toolCall.name, summarizeToolInput(toolCall), 'terminating', toolCall.input, { status: 'terminating', message: 'Analysis terminated by AI decision' });

        // Return immediately with early termination
        if (toolResults.length > 0) {
          updatedMessages.push(client.buildToolResultsMessage(toolResults));
        }

        return {
          messages: updatedMessages,
          recommendations,
          shouldStop: true,
          stopReason: 'early_termination',
          terminationReason: toolCall.input.reason,
          accumulatedInsightId: accumulatedInsightId || undefined,
          accumulatedInsights,
          toolCallNames: callResult.toolCalls.map(tc => tc.name),
          inputTokens: callResult.inputTokens,
          outputTokens: callResult.outputTokens
        };
      }

      // Handle general_insight (accumulation logic - does NOT count toward action limit)
      if (isGeneralInsightTool(toolCall.name)) {
        const input = toolCall.input;

        // Add to accumulated insights array
        accumulatedInsights.push({
          title: input.title,
          insight: input.insight,
          category: input.category,
          affected_entities: input.affected_entities,
          suggested_action: input.suggested_action,
          confidence: input.confidence
        });

        if (accumulatedInsightId) {
          // UPDATE existing row - subsequent insights just append (no limit)
          await this.updateAccumulatedInsight(orgId, accumulatedInsightId, accumulatedInsights);
          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: {
              status: 'appended',
              message: `Insight appended to accumulated document (${accumulatedInsights.length} total). You can continue adding insights - they don't count toward your action recommendation limit.`,
              total_insights: accumulatedInsights.length
            }
          });
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'appended', toolCall.input, { status: 'appended', total_insights: accumulatedInsights.length });
        } else {
          // CREATE new row - insight is separate from action recommendations
          accumulatedInsightId = await this.createAccumulatedInsight(orgId, accumulatedInsights, runId);

          // Add placeholder to recommendations list (for return value, but NOT for limit counting)
          recommendations.push({
            tool: 'accumulated_insight',
            platform: 'general',
            entity_type: 'insight',
            entity_id: 'accumulated',
            entity_name: 'Analysis Insights',
            parameters: {},
            reason: 'Accumulated insights from analysis',
            predicted_impact: null,
            confidence: 'medium'
          });

          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: {
              status: 'created',
              message: 'Accumulated insight document created. Additional insights will append to this document. Insights are separate from action recommendations - you can add up to 3 action recommendations (set_budget, set_status, set_audience, reallocate_budget).',
              total_insights: 1,
              action_recommendations_remaining: maxActionRecommendations - actionRecommendations.length
            }
          });
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'created', toolCall.input, { status: 'created', total_insights: 1 });
        }
        continue;
      }

      // Handle action recommendation tools (set_budget, set_status, set_audience, reallocate_budget)
      // These count toward the action limit, separate from insights
      if (isRecommendationTool(toolCall.name) && !isGeneralInsightTool(toolCall.name) && !isTerminateAnalysisTool(toolCall.name)) {
        if (hitMaxActionRecommendations || actionRecommendations.length >= maxActionRecommendations) {
          hitMaxActionRecommendations = true;
          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: {
              status: 'skipped',
              message: `Maximum action recommendations (${maxActionRecommendations}) reached. You can still add insights via general_insight.`
            }
          });
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'skipped', toolCall.input, { status: 'skipped' });
          continue;
        }

        // For set_status and set_budget, use simulation-required enforcement
        if (requiresSimulation(toolCall.name)) {
          const simContext: ToolExecutionContext = {
            orgId,
            analysisRunId: runId,
            analyticsDb: this.env.ANALYTICS_DB,
            aiDb: this.env.DB,
            simulationCache,
            platform: toolCall.input.platform
          };

          const simResult = await executeRecommendationWithSimulation(
            toolCall.name,
            toolCall.input,
            simContext
          );

          if (!simResult.success) {
            toolResults.push({
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: {
                status: 'simulation_required',
                error: simResult.error,
                message: simResult.message,
                recommendation: simResult.recommendation
              }
            });
            await logEvent(toolCall.name, summarizeToolInput(toolCall), 'simulation_required', toolCall.input, { status: 'simulation_required', error: simResult.error, recommendation: simResult.recommendation });
            continue;
          }

          // Simulation was done, recommendation created with CALCULATED impact
          const rec = parseToolCallToRecommendation(toolCall.name, {
            ...toolCall.input,
            predicted_impact: simResult.data?.calculated_impact
          });
          recommendations.push(rec);
          actionRecommendations.push(rec);

          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: {
              status: 'logged',
              message: simResult.message,
              recommendation_id: simResult.recommendation_id,
              calculated_impact: simResult.data?.calculated_impact,
              action_recommendation_count: actionRecommendations.length,
              action_recommendations_remaining: maxActionRecommendations - actionRecommendations.length
            }
          });
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged', toolCall.input, { status: 'logged', calculated_impact: simResult.data?.calculated_impact, recommendation_id: simResult.recommendation_id });

          if (actionRecommendations.length >= maxActionRecommendations) {
            hitMaxActionRecommendations = true;
          }
          continue;
        }

        // For other tools (set_audience, reallocate_budget), use direct logging
        const rec = parseToolCallToRecommendation(toolCall.name, toolCall.input);
        recommendations.push(rec);
        actionRecommendations.push(rec);

        // Log to ai_decisions
        await this.logRecommendation(orgId, rec, runId);

        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: {
            status: 'logged',
            action_recommendation_count: actionRecommendations.length,
            action_recommendations_remaining: maxActionRecommendations - actionRecommendations.length
          }
        });
        await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged', toolCall.input, { status: 'logged', action_recommendation_count: actionRecommendations.length });

        if (actionRecommendations.length >= maxActionRecommendations) {
          hitMaxActionRecommendations = true;
        }
      }
    }

    // Add tool results to messages
    if (toolResults.length > 0) {
      updatedMessages.push(client.buildToolResultsMessage(toolResults));
    }

    return {
      messages: updatedMessages,
      recommendations,
      actionRecommendations,
      shouldStop: hitMaxActionRecommendations,
      stopReason: hitMaxActionRecommendations ? 'max_recommendations' : undefined,
      accumulatedInsightId: accumulatedInsightId || undefined,
      accumulatedInsights,
      toolCallNames: callResult.toolCalls.map(tc => tc.name),
      inputTokens: callResult.inputTokens,
      outputTokens: callResult.outputTokens
    };
  }

  /**
   * Get final summary from agentic loop
   */
  private async getAgenticFinalSummary(
    messages: any[],
    systemPrompt: string,
    enableExploration: boolean,
    orgId?: string,
    client?: AgenticClient
  ): Promise<{ summary: string | null; inputTokens: number; outputTokens: number }> {
    const explorationTools = enableExploration && orgId
      ? await getExplorationToolsForOrg(this.env.ANALYTICS_DB, orgId)
      : enableExploration ? getExplorationToolDefinitions() : [];
    const tools = [...getToolDefinitions(), ...explorationTools] as AgenticToolDef[];

    if (!client) {
      // Fallback: create a new client if none provided (shouldn't happen in practice)
      const geminiKey = await getSecret(this.env.GEMINI_API_KEY);
      client = createAgenticClient('gemini', geminiKey!, GEMINI_MODELS.FLASH);
    }

    try {
      const callResult = await client.call(messages, systemPrompt, tools);
      return {
        summary: callResult.textBlocks.join('\n') || null,
        inputTokens: callResult.inputTokens,
        outputTokens: callResult.outputTokens
      };
    } catch {
      return { summary: null, inputTokens: 0, outputTokens: 0 };
    }
  }

  /**
   * Log recommendation to ai_decisions table
   */
  private async logRecommendation(
    orgId: string,
    rec: Recommendation,
    analysisRunId: string,
    simulationResult?: SimulationResult | null
  ): Promise<void> {
    // Dedup: skip if an identical pending decision already exists (workflow retry safety)
    const existing = await this.env.DB.prepare(`
      SELECT id FROM ai_decisions
      WHERE organization_id = ? AND tool = ? AND platform = ? AND entity_type = ? AND entity_id = ?
        AND status = 'pending'
      LIMIT 1
    `).bind(orgId, rec.tool, rec.platform, rec.entity_type, rec.entity_id).first<{ id: string }>();

    if (existing) return;

    const id = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Build current_state from the LLM's tool input parameters
    const currentState: Record<string, any> = {};
    const params = rec.parameters || {};
    if (params.current_budget_cents !== undefined) currentState.daily_budget = params.current_budget_cents;
    if (params.current_status !== undefined) currentState.status = params.current_status;
    if (params.current_bid_cents !== undefined) currentState.bid_cents = params.current_bid_cents;
    if (params.current_strategy !== undefined) currentState.strategy = params.current_strategy;

    // Build simulation_data if simulation result is available
    const simulationData = simulationResult ? JSON.stringify({
      current_state: simulationResult.current_state,
      simulated_state: simulationResult.simulated_state,
      diminishing_returns_model: simulationResult.diminishing_returns_model
    }) : null;
    const simulationConfidence = simulationResult?.confidence ?? null;

    await this.env.DB.prepare(`
      INSERT INTO ai_decisions (
        id, organization_id, tool, platform, entity_type, entity_id, entity_name,
        parameters, current_state, reason, predicted_impact, confidence, status, expires_at,
        supporting_data, simulation_data, simulation_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).bind(
      id,
      orgId,
      rec.tool,
      rec.platform,
      rec.entity_type,
      rec.entity_id,
      rec.entity_name,
      JSON.stringify(rec.parameters),
      JSON.stringify(currentState),
      rec.reason,
      rec.predicted_impact,
      rec.confidence,
      expiresAt.toISOString(),
      JSON.stringify({ analysis_run_id: analysisRunId }),
      simulationData,
      simulationConfidence
    ).run();
  }

  /**
   * Create a new accumulated insight document
   */
  private async createAccumulatedInsight(
    orgId: string,
    insights: AccumulatedInsightData[],
    analysisRunId: string
  ): Promise<string> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.env.DB.prepare(`
      INSERT INTO ai_decisions (
        id, organization_id, tool, platform, entity_type, entity_id, entity_name,
        parameters, reason, predicted_impact, confidence, status, expires_at,
        supporting_data, simulation_data, simulation_confidence
      ) VALUES (?, ?, 'accumulated_insight', 'general', 'insight', 'accumulated', ?, ?, ?, NULL, 'medium', 'pending', ?, ?, NULL, NULL)
    `).bind(
      id,
      orgId,
      `Analysis Insights (${insights.length})`,
      JSON.stringify({ insights, total_insights: insights.length }),
      insights.map(i => i.insight).join('\n\n---\n\n'),
      expiresAt.toISOString(),
      JSON.stringify({ analysis_run_id: analysisRunId })
    ).run();

    return id;
  }

  /**
   * Update an existing accumulated insight document with new insights
   */
  private async updateAccumulatedInsight(
    orgId: string,
    insightId: string,
    insights: AccumulatedInsightData[]
  ): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE ai_decisions
      SET parameters = ?,
          reason = ?,
          entity_name = ?
      WHERE id = ? AND organization_id = ?
    `).bind(
      JSON.stringify({ insights, total_insights: insights.length }),
      insights.map(i => i.insight).join('\n\n---\n\n'),
      `Analysis Insights (${insights.length})`,
      insightId,
      orgId
    ).run();
  }
}
