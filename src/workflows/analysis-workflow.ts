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
  isUpdateRecommendationTool,
  isDeleteRecommendationTool,
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
      return `${input.pause_source ? 'Pause & reallocate' : 'Reallocate'} budget: ${input.from_entity_name || ''} → ${input.to_entity_name || ''}`;
    case 'update_recommendation':
      return `Update ${input.original_tool || 'recommendation'} for entity ${input.original_entity_id || ''}`;
    case 'delete_recommendation':
      return `Delete ${input.original_tool || 'recommendation'} for entity ${input.original_entity_id || ''}`;
    default:
      // Exploration tools (query_*)
      if (toolCall.name.startsWith('query_')) {
        return `Query ${toolCall.name.replace('query_', '').replace(/_/g, ' ')}`;
      }
      return toolCall.name;
  }
}

/**
 * Validate spend limits on action recommendations before they are accepted.
 * Returns { valid: true } if within limits, or { valid: false, violation, details } if breached.
 */
function validateSpendLimits(
  toolName: string,
  toolInput: any,
  config: AnalysisWorkflowParams['config'] | undefined,
  simulationData?: any
): { valid: boolean; violation?: string; details?: string } {
  if (!config) return { valid: true };

  const { dailyCapCents, monthlyCapCents, maxCacCents } = config;

  if (toolName === 'set_budget') {
    const recBudget = toolInput.recommended_budget_cents;
    if (typeof recBudget !== 'number') return { valid: true };

    if (dailyCapCents && toolInput.budget_type === 'daily' && recBudget > dailyCapCents) {
      return {
        valid: false,
        violation: 'daily_cap_exceeded',
        details: `Recommended daily budget $${(recBudget / 100).toFixed(2)} exceeds daily cap $${(dailyCapCents / 100).toFixed(2)}. Reduce to at most $${(dailyCapCents / 100).toFixed(2)}. Use update_recommendation to lower the budget or delete_recommendation to withdraw it.`
      };
    }
    if (monthlyCapCents && toolInput.budget_type === 'daily' && recBudget * 30 > monthlyCapCents) {
      const maxDaily = Math.floor(monthlyCapCents / 30);
      return {
        valid: false,
        violation: 'monthly_cap_exceeded',
        details: `Recommended daily budget $${(recBudget / 100).toFixed(2)} × 30 days = $${((recBudget * 30) / 100).toFixed(2)}/mo, exceeding monthly cap $${(monthlyCapCents / 100).toFixed(2)}. Max daily: $${(maxDaily / 100).toFixed(2)}. Use update_recommendation to lower the budget or delete_recommendation to withdraw it.`
      };
    }
  }

  if (toolName === 'reallocate_budget') {
    const amount = toolInput.amount_cents;
    if (typeof amount !== 'number') return { valid: true };

    if (dailyCapCents && amount > dailyCapCents) {
      return {
        valid: false,
        violation: 'daily_cap_exceeded',
        details: `Reallocation amount $${(amount / 100).toFixed(2)}/day exceeds daily cap $${(dailyCapCents / 100).toFixed(2)}. Use update_recommendation to lower the amount or delete_recommendation to withdraw it.`
      };
    }
    if (monthlyCapCents && amount * 30 > monthlyCapCents) {
      const maxDaily = Math.floor(monthlyCapCents / 30);
      return {
        valid: false,
        violation: 'monthly_cap_exceeded',
        details: `Reallocation amount $${(amount / 100).toFixed(2)}/day × 30 = $${((amount * 30) / 100).toFixed(2)}/mo, exceeding monthly cap $${(monthlyCapCents / 100).toFixed(2)}. Max daily: $${(maxDaily / 100).toFixed(2)}. Use update_recommendation to lower the amount or delete_recommendation to withdraw it.`
      };
    }
  }

  // CAC ceiling check using simulation projected CAC
  if (maxCacCents && simulationData?.projected_cac_cents) {
    if (simulationData.projected_cac_cents > maxCacCents) {
      return {
        valid: false,
        violation: 'cac_ceiling_exceeded',
        details: `Projected CAC $${(simulationData.projected_cac_cents / 100).toFixed(2)} exceeds ceiling $${(maxCacCents / 100).toFixed(2)}. Reduce the budget change or choose a different entity. Use update_recommendation to adjust or delete_recommendation to withdraw it.`
      };
    }
  }

  return { valid: true };
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

    const { crossPlatformSummary, platformSummaries, activeCampaignCount } = portfolioResult;
    const additionalContext = portfolioResult.additionalContext || '';
    let processedCount = portfolioResult.processedCount;
    // Active tree is the full entity tree — agent uses exploration tools for drill-down
    const activeTree = entityTree;

    // Steps 7+: Agentic loop — real limit is context length, not iteration count.
    // Gemini Flash: 1M context, Claude: 200K. Set iteration cap high enough that
    // context exhaustion is always the binding constraint.
    const maxIterations = 1000;

    // Scale action recommendation slots with account size + growth strategy
    const baseScaledMax = activeCampaignCount >= 20 ? 7
      : activeCampaignCount >= 8 ? 5
      : 3;
    const baseMinExplore = activeCampaignCount >= 20 ? 7
      : activeCampaignCount >= 8 ? 5
      : 3;

    // Growth strategy modifier: lean = less exploring/fewer slots, bold = more
    const growthMod = (config?.growthStrategy === 'bold') ? 2
      : (config?.growthStrategy === 'lean') ? -1
      : 0;

    const scaledMax = Math.max(2, Math.min(10, baseScaledMax + growthMod));
    const minExplorationTurns = Math.max(2, Math.min(10, baseMinExplore + growthMod));

    // Use scaledMax as the baseline. Config override can increase but not decrease below scaledMax,
    // since old configs may have the former hardcoded default (3). Insights are tracked separately
    // and do NOT consume action slots, so no "-1 reserve" is needed.
    const maxActionRecommendations = config?.agentic?.maxRecommendations
      ? Math.max(config.agentic.maxRecommendations, scaledMax)
      : scaledMax;
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

      // Fetch active watchlist items for cross-run memory
      let watchlistItems: Array<{ id: string; entity_ref: string; entity_name: string; platform: string; entity_type: string; watch_type: string; note: string; review_after: string | null; created_at: string }> = [];
      try {
        const wlResult = await this.env.DB.prepare(`
          SELECT id, entity_ref, entity_name, platform, entity_type,
                 watch_type, note, review_after, created_at
          FROM analysis_watchlist
          WHERE organization_id = ? AND status = 'active'
          ORDER BY review_after ASC NULLS LAST
          LIMIT 2
        `).bind(orgId).all();
        watchlistItems = (wlResult.results || []) as typeof watchlistItems;
      } catch { /* watchlist table may not exist yet — non-critical */ }

      // Build initial messages
      const contextPrompt = this.buildAgenticContextPrompt(crossPlatformSummary, platformSummaries, additionalContext, activeCampaignCount, maxActionRecommendations);

      return {
        recentRecs,
        contextPrompt,
        systemPrompt: this.buildAgenticSystemPrompt(days, customInstructions, recentRecs, config, activeCampaignCount, minExplorationTurns, maxActionRecommendations, watchlistItems)
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

    // ── Strategist sub-agent: scout data landscape before main loop ──
    // The strategist runs a short exploration loop with a meta-aware prompt,
    // discovers what data exists and what patterns it reveals, then writes a
    // tactical briefing injected into the main agent's system prompt.
    const preLoopExplorationTools = enableExploration
      ? await getExplorationToolsForOrg(this.env.ANALYTICS_DB, orgId)
      : [];
    let strategistBriefing = '';
    let activeSystemPrompt = agenticContext.systemPrompt;

    if (enableExploration && preLoopExplorationTools.length > 0) {
      try {
        const strategistResult = await step.do('strategist_briefing_0', {
          retries: { limit: 1, delay: '5 seconds' },
          timeout: '2 minutes'
        }, async () => {
          return await this.runStrategistBriefing(
            agenticClient,
            agenticContext.contextPrompt,
            entityTree,
            preLoopExplorationTools as AgenticToolDef[],
            orgId,
            jobId
          );
        });

        totalInputTokens += strategistResult.inputTokens;
        totalOutputTokens += strategistResult.outputTokens;
        strategistBriefing = strategistResult.briefing;

        // Inject briefing into system prompt
        if (strategistBriefing) {
          activeSystemPrompt += `\n\n## STRATEGIST BRIEFING (auto-generated — prioritize these tool suggestions)\n\n${strategistBriefing}`;
        }

        // Log strategist event
        try {
          await this.env.DB.prepare(
            `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'strategist', NULL, ?, NULL)`
          ).bind(jobId, orgId, strategistBriefing.substring(0, 500)).run();
        } catch (e) { /* non-critical */ }

        console.log(`[Analysis] Strategist briefing generated (${strategistResult.inputTokens} in / ${strategistResult.outputTokens} out tokens)`);
      } catch (e) {
        // Strategist failure is non-critical — main loop runs without briefing
        console.error('[Analysis] Strategist briefing failed, continuing without:', e);
      }
    }

    // Run agentic iterations as separate steps
    // Loop continues until: we have an insight AND 3 action recs, OR max iterations, OR early termination
    const budgetStrategy = config?.budgetStrategy || 'moderate';
    let nudgeCount = 0;  // Track nudge attempts (max 2 to avoid infinite loops)

    // Sequential pattern tracker: detect when LLM makes one exploration call per turn
    let consecutiveSingleExplore = 0;
    let lastSingleExploreTool = '';
    let sequentialNudgeFired = false;

    // Display the full turn budget to give the LLM room to explore
    const displayMaxIterations = 200;

    while (iterations < maxIterations && actionRecommendations.length < maxActionRecommendations) {
      iterations++;

      // Inject iteration counter as semantic pressure before each LLM call
      const phase = iterations <= minExplorationTurns ? 'EXPLORE' : 'SIMULATE/RECOMMEND';
      const remainingSlots = maxActionRecommendations - actionRecommendations.length;
      const turnBudgetMessage = `⏱ Turn ${iterations}/${displayMaxIterations} [Phase: ${phase}]. Remaining action slots: ${remainingSlots}/${maxActionRecommendations}.${
        iterations <= minExplorationTurns
          ? ` Exploration phase: ${minExplorationTurns - iterations} turns remaining. Action tools are BLOCKED — focus on drilling into ad groups AND individual ads.`
          : remainingSlots > 0
            ? ` You have ${remainingSlots} unfilled action slot(s). Do NOT call terminate_analysis until all ${maxActionRecommendations} slots are filled. Simulate → recommend → repeat.`
            : ' All slots filled. Call terminate_analysis with your summary.'
      }`;

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
          activeSystemPrompt,
          recommendations,
          actionRecommendations,
          maxActionRecommendations,
          enableExploration,
          accumulatedInsightId,
          accumulatedInsights,
          hasInsight,
          simulationCache,  // Pass simulation cache for enforced simulation before recommendations
          agenticClient,
          minExplorationTurns,
          config
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

      // ── Mid-loop strategist refresh: re-run every 10 iterations ──
      if (
        enableExploration &&
        iterations > 0 &&
        iterations % 10 === 0 &&
        actionRecommendations.length < maxActionRecommendations &&
        preLoopExplorationTools.length > 0
      ) {
        try {
          // Gather tool call history from analysis_events
          const recentEvents = await this.env.DB.prepare(
            `SELECT tool_name, tool_input_summary FROM analysis_events
             WHERE job_id = ? AND tool_name IS NOT NULL
             ORDER BY iteration DESC LIMIT 30`
          ).bind(jobId).all<{ tool_name: string; tool_input_summary: string | null }>();
          const toolLog = (recentEvents.results || []).map(
            (e) => `${e.tool_name}: ${e.tool_input_summary || ''}`
          );

          const refreshResult = await step.do(`strategist_briefing_${iterations}`, {
            retries: { limit: 1, delay: '5 seconds' },
            timeout: '2 minutes'
          }, async () => {
            return await this.runStrategistBriefing(
              agenticClient,
              agenticContext.contextPrompt,
              entityTree,
              preLoopExplorationTools as AgenticToolDef[],
              orgId,
              jobId,
              {
                recommendations: actionRecommendations,
                toolCallLog: toolLog,
                previousBriefing: strategistBriefing,
                iteration: iterations
              }
            );
          });

          totalInputTokens += refreshResult.inputTokens;
          totalOutputTokens += refreshResult.outputTokens;
          strategistBriefing = refreshResult.briefing;

          // Rebuild system prompt with updated briefing
          activeSystemPrompt = agenticContext.systemPrompt +
            `\n\n## STRATEGIST BRIEFING (updated at iteration ${iterations})\n\n${strategistBriefing}`;

          console.log(`[Analysis] Strategist refresh at iteration ${iterations} (${refreshResult.inputTokens} in / ${refreshResult.outputTokens} out tokens)`);
        } catch (e) {
          // Non-critical — continue with existing briefing
          console.error(`[Analysis] Strategist refresh at iteration ${iterations} failed:`, e);
        }
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
        // Unfilled slots nudge: one chance to fill remaining action slots before accepting
        // termination. Only fires once (nudgeCount < 1) — if the agent still wants to quit
        // after being nudged, respect that decision instead of burning tokens on retries.
        if (
          nudgeCount < 1 &&
          actionRecommendations.length > 0 &&
          actionRecommendations.length < maxActionRecommendations &&
          (iterResult.stopReason === 'early_termination')
        ) {
          nudgeCount++;
          const remaining = maxActionRecommendations - actionRecommendations.length;
          const actionTypes = new Set(actionRecommendations.map(r => r.tool));
          const existingActions = actionRecommendations.map(r => `${r.tool}: ${(r as any).entity_name || 'unknown'}`).join(', ');

          // Tailor guidance based on what's already been recommended
          let suggestion: string;
          if (actionTypes.has('set_status') && !actionTypes.has('reallocate_budget')) {
            suggestion = `You paused a campaign — use reallocate_budget to redirect that freed budget to your highest-efficiency campaign. This completes the optimization story: cut waste AND reinvest savings.`;
          } else if (actionTypes.has('set_budget') && !actionTypes.has('set_status')) {
            suggestion = `Consider using set_status to pause any campaign with zero conversions or a declining trend. Budget cuts alone leave underperformers still spending.`;
          } else if (!actionTypes.has('reallocate_budget')) {
            suggestion = `Consider reallocate_budget to shift spend from the weakest remaining campaign to the strongest. Budget-neutral swaps are low-risk, high-value.`;
          } else {
            suggestion = `Look for the next-weakest campaign by efficiency score. Even small optimizations compound — simulate a budget adjustment or status change.`;
          }

          // Run strategist to scout unexplored data before nudging the agent back in
          let nudgeBriefing = '';
          if (enableExploration && preLoopExplorationTools.length > 0) {
            try {
              const recentEvents = await this.env.DB.prepare(
                `SELECT tool_name, tool_input_summary FROM analysis_events
                 WHERE job_id = ? AND tool_name IS NOT NULL
                 ORDER BY iteration DESC LIMIT 30`
              ).bind(jobId).all<{ tool_name: string; tool_input_summary: string | null }>();
              const toolLog = (recentEvents.results || []).map(
                (e) => `${e.tool_name}: ${e.tool_input_summary || ''}`
              );

              const nudgeStrategist = await step.do(`strategist_nudge_${iterations}`, {
                retries: { limit: 1, delay: '5 seconds' },
                timeout: '2 minutes'
              }, async () => {
                return await this.runStrategistBriefing(
                  agenticClient,
                  agenticContext.contextPrompt,
                  entityTree,
                  preLoopExplorationTools as AgenticToolDef[],
                  orgId,
                  jobId,
                  {
                    recommendations: actionRecommendations,
                    toolCallLog: toolLog,
                    previousBriefing: strategistBriefing,
                    iteration: iterations
                  }
                );
              });

              totalInputTokens += nudgeStrategist.inputTokens;
              totalOutputTokens += nudgeStrategist.outputTokens;
              nudgeBriefing = nudgeStrategist.briefing;
              strategistBriefing = nudgeBriefing;

              // Update system prompt with fresh briefing
              activeSystemPrompt = agenticContext.systemPrompt +
                `\n\n## STRATEGIST BRIEFING (updated at nudge, iteration ${iterations})\n\n${nudgeBriefing}`;

              console.log(`[Analysis] Strategist re-run for unfilled slots nudge (${nudgeStrategist.inputTokens} in / ${nudgeStrategist.outputTokens} out tokens)`);
            } catch (e) {
              console.error('[Analysis] Strategist nudge refresh failed:', e);
            }
          }

          const strategistHint = nudgeBriefing
            ? `\n\n## STRATEGIST RECON (fresh data for your remaining slot)\n${nudgeBriefing}`
            : '';

          agenticMessages = [
            ...iterResult.messages,
            agenticClient.buildUserMessage(
              `UNFILLED ACTION SLOTS: You've made ${actionRecommendations.length} recommendation(s) (${existingActions}) but have ${remaining} action slot(s) remaining. ` +
              `The user is paying for a complete optimization — use all ${maxActionRecommendations} slots.\n\n` +
              `${suggestion}${strategistHint}\n\n` +
              `Use simulate_change on a specific entity, then create the recommendation. Do NOT call terminate_analysis until all ${maxActionRecommendations} slots are filled.`
            )
          ];
          console.log(`[Analysis] Unfilled slots nudge: ${actionRecommendations.length}/${maxActionRecommendations} actions, pushing for ${remaining} more`);
          continue;  // Re-enter the loop
        }

        // Pre-termination nudge: if the agent is stopping with zero actions, push it to
        // generate at least one concrete recommendation before giving up. Users pay for
        // analysis — "everything looks great" with no actions is not acceptable output.
        if (
          nudgeCount < 2 &&
          actionRecommendations.length === 0 &&
          (iterResult.stopReason === 'no_tool_calls' || iterResult.stopReason === 'early_termination')
        ) {
          nudgeCount++;

          if (nudgeCount === 1) {
            // First nudge: strategy-specific guidance
            const strategyNudge = budgetStrategy === 'aggressive'
              ? `You are in AGGRESSIVE budget mode — the user expects bold action recommendations.\n` +
                `- Increase budget on the highest-efficiency campaign by 15-20%\n` +
                `- Re-enable paused campaigns with strong historical ROAS\n`
              : budgetStrategy === 'conservative'
              ? `You are in CONSERVATIVE budget mode — the user wants to cut waste and protect margins.\n` +
                `- Decrease budget on the WEAKEST active campaign (lowest efficiency score) by 15-20%\n` +
                `- If any campaign has a declining trend (CVR dropping, CPA increasing), decrease its budget\n`
              : `You are in MODERATE budget mode — reallocate for better results.\n` +
                `- Use reallocate_budget to shift 10-15% from the weakest campaign to the strongest\n` +
                `- If any campaign has declining trends, reduce its budget and redistribute\n`;

            agenticMessages = [
              ...iterResult.messages,
              agenticClient.buildUserMessage(
                `IMPORTANT: You have not made any action recommendations yet. Insights alone are not enough — ` +
                `the user is paying for actionable optimization suggestions, not just observations.\n\n` +
                `${strategyNudge}\n` +
                `Even if the portfolio is performing well overall, there are ALWAYS optimization opportunities:\n` +
                `- The weakest campaign can always have budget shifted to the strongest\n` +
                `- Campaigns with declining trends should have budgets reduced proactively\n` +
                `- Budget allocation can always be optimized to match efficiency scores\n\n` +
                `DO NOT use general_insight. Use simulate_change on a specific entity, then call set_budget or reallocate_budget.`
              )
            ];
            console.log(`[Analysis] Pre-termination nudge #1: LLM stopped with no actions (${budgetStrategy} mode)`);
          } else {
            // Second nudge: direct instruction — pick the weakest campaign and act
            agenticMessages = [
              ...iterResult.messages,
              agenticClient.buildUserMessage(
                `FINAL WARNING: You MUST produce at least one action recommendation. Do NOT call general_insight or terminate_analysis.\n\n` +
                `Here is exactly what to do:\n` +
                `1. Find the campaign with the LOWEST efficiency score or the WORST declining trend\n` +
                `2. Call simulate_change with action='decrease_budget' (or 'pause' if it has zero conversions) on that entity\n` +
                `3. Based on the simulation result, call set_budget (or set_status) to recommend the change\n\n` +
                `This is your last chance to produce an action. If you call terminate_analysis or general_insight instead, the analysis will be marked as failed.`
              )
            ];
            console.log(`[Analysis] Pre-termination nudge #2 (final): forcing action on weakest entity (${budgetStrategy} mode)`);
          }
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
          activeSystemPrompt + `\n\nYou have made ${maxActionRecommendations} recommendations which is the maximum. Provide a brief final summary.`,
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
    activeCampaignCount: number;
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

    // ── Query 1c: 30-day campaign metrics for multi-horizon comparison ──
    // Only fetch if analysis window is shorter than 30 days (otherwise redundant)
    let campaigns30dMap = new Map<string, {
      spend_cents: number; impressions: number; clicks: number;
      conversions: number; revenue_cents: number; active_days: number;
    }>();
    if (days < 30) {
      try {
        const campaigns30d = await this.env.ANALYTICS_DB.prepare(`
          SELECT
            c.id as campaign_uuid,
            COALESCE(SUM(am.spend_cents), 0) as spend_cents,
            COALESCE(SUM(am.impressions), 0) as impressions,
            COALESCE(SUM(am.clicks), 0) as clicks,
            COALESCE(SUM(am.conversions), 0) as conversions,
            COALESCE(SUM(am.conversion_value_cents), 0) as revenue_cents,
            COUNT(DISTINCT am.metric_date) as active_days
          FROM ad_campaigns c
          LEFT JOIN ad_metrics am ON am.entity_ref = c.id
            AND am.entity_type = 'campaign'
            AND am.organization_id = c.organization_id
            AND am.metric_date >= date('now', '-30 days')
          WHERE c.organization_id = ?
            AND c.campaign_status != 'REMOVED'
          GROUP BY c.id
        `).bind(orgId).all<{
          campaign_uuid: string;
          spend_cents: number; impressions: number; clicks: number;
          conversions: number; revenue_cents: number; active_days: number;
        }>();
        for (const r of campaigns30d.results || []) {
          campaigns30dMap.set(r.campaign_uuid, r);
        }
      } catch { /* 30d query is non-critical */ }
    }

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
      campaign_uuid: string;
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
        campaign_uuid: c.campaign_uuid,
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

    // ── Query ad group and ad level metrics for nested outline ──
    interface SubEntityMetrics {
      entity_ref: string;
      parent_ref: string;
      name: string;
      spend_cents: number;
      impressions: number;
      clicks: number;
      conversions: number;
      revenue_cents: number;
      active_days: number;
    }

    let adGroupMetrics: SubEntityMetrics[] = [];
    let adMetrics: SubEntityMetrics[] = [];

    try {
      const agResult = await this.env.ANALYTICS_DB.prepare(`
        SELECT
          am.entity_ref,
          ag.campaign_ref as parent_ref,
          ag.ad_group_name as name,
          COALESCE(SUM(am.spend_cents), 0) as spend_cents,
          COALESCE(SUM(am.impressions), 0) as impressions,
          COALESCE(SUM(am.clicks), 0) as clicks,
          COALESCE(SUM(am.conversions), 0) as conversions,
          COALESCE(SUM(am.conversion_value_cents), 0) as revenue_cents,
          COUNT(DISTINCT am.metric_date) as active_days
        FROM ad_metrics am
        JOIN ad_groups ag ON ag.id = am.entity_ref AND ag.organization_id = am.organization_id
        WHERE am.organization_id = ? AND am.entity_type = 'ad_group'
          AND am.metric_date >= ? AND am.metric_date <= ?
        GROUP BY am.entity_ref
        ORDER BY spend_cents DESC
      `).bind(orgId, dateRange.start, dateRange.end).all<SubEntityMetrics>();
      adGroupMetrics = agResult.results || [];
    } catch { /* ad_groups may not have metrics */ }

    try {
      const adResult = await this.env.ANALYTICS_DB.prepare(`
        SELECT
          am.entity_ref,
          a.ad_group_ref as parent_ref,
          a.ad_name as name,
          COALESCE(SUM(am.spend_cents), 0) as spend_cents,
          COALESCE(SUM(am.impressions), 0) as impressions,
          COALESCE(SUM(am.clicks), 0) as clicks,
          COALESCE(SUM(am.conversions), 0) as conversions,
          COALESCE(SUM(am.conversion_value_cents), 0) as revenue_cents,
          COUNT(DISTINCT am.metric_date) as active_days
        FROM ad_metrics am
        JOIN ads a ON a.id = am.entity_ref AND a.organization_id = am.organization_id
        WHERE am.organization_id = ? AND am.entity_type = 'ad'
          AND am.metric_date >= ? AND am.metric_date <= ?
        GROUP BY am.entity_ref
        ORDER BY spend_cents DESC
      `).bind(orgId, dateRange.start, dateRange.end).all<SubEntityMetrics>();
      adMetrics = adResult.results || [];
    } catch { /* ads may not have metrics */ }

    // Index sub-entities by parent
    const adGroupsByParent = new Map<string, SubEntityMetrics[]>();
    for (const ag of adGroupMetrics) {
      const list = adGroupsByParent.get(ag.parent_ref) || [];
      list.push(ag);
      adGroupsByParent.set(ag.parent_ref, list);
    }
    const adsByParent = new Map<string, SubEntityMetrics[]>();
    for (const ad of adMetrics) {
      const list = adsByParent.get(ad.parent_ref) || [];
      list.push(ad);
      adsByParent.set(ad.parent_ref, list);
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
    // When verified revenue is available, distribute proportionally by spend share
    // (same approach as per-campaign metrics). Platform-reported revenue is near-zero
    // for most orgs, so showing it would make ROAS look broken.
    const platformNames = Object.keys(platformAgg);
    if (platformNames.length > 0) {
      summary += `### Per-Platform Breakdown\n`;
      summary += `| Platform | Spend | Revenue | ROAS | CPA | CTR | Conversions |\n|---|---|---|---|---|---|---|\n`;
      for (const p of platformNames) {
        const m = platformAgg[p];
        const effectivePlatformRevenue = hasVerifiedRevenue && totalSpendCents > 0
          ? Math.round(verifiedRevenueCents * (m.spend_cents / totalSpendCents))
          : m.revenue_cents;
        const effectivePlatformConversions = hasVerifiedRevenue && totalSpendCents > 0
          ? Math.round(verifiedConversions * (m.spend_cents / totalSpendCents))
          : m.conversions;
        const pRoas = m.spend_cents > 0 ? (effectivePlatformRevenue / m.spend_cents).toFixed(2) + 'x' : 'N/A';
        const pCpa = effectivePlatformConversions > 0 ? fmt(Math.round(m.spend_cents / effectivePlatformConversions)) : 'N/A';
        const pCtr = pct(m.clicks, m.impressions);
        const share = totalSpendCents > 0 ? ` (${(m.spend_cents / totalSpendCents * 100).toFixed(0)}%)` : '';
        summary += `| ${p.charAt(0).toUpperCase() + p.slice(1)} | ${fmt(m.spend_cents)}${share} | ${fmt(effectivePlatformRevenue)} | ${pRoas} | ${pCpa} | ${pCtr} | ${effectivePlatformConversions.toLocaleString()} |\n`;
      }
      summary += '\n';
    }

    // ── Nested Entity Outline (Platform > Campaign > Ad Group > Ad) ──
    // Token budget: ~40k tokens ≈ ~160k chars. Paginate if we exceed that.
    const TOKEN_CHAR_RATIO = 4; // ~4 chars per token
    const MAX_OUTLINE_CHARS = 40000 * TOKEN_CHAR_RATIO; // ~40k tokens

    const withSpend = analyzed.filter(c => c.spend_cents >= 100); // $1 minimum
    const allSorted = [...withSpend].sort((a, b) => b.efficiency_score - a.efficiency_score);
    const pausedCampaigns = analyzed.filter(c => c.spend_cents === 0 && c.flags.length > 0);
    const totalCampaignCount = allSorted.length + pausedCampaigns.length;

    // Group campaigns by platform for nested outline
    const campaignsByPlatform = new Map<string, typeof allSorted>();
    for (const c of allSorted) {
      const list = campaignsByPlatform.get(c.platform) || [];
      list.push(c);
      campaignsByPlatform.set(c.platform, list);
    }

    // Build nested outline with character budget tracking
    let outlineChars = 0;
    let outlineTruncated = false;
    let campaignsShown = 0;
    let campaignsHidden = 0;

    // Helper to format sub-entity line
    const fmtSub = (s: SubEntityMetrics) => {
      const ctr = s.impressions > 0 ? (s.clicks / s.impressions * 100).toFixed(1) + '%' : 'N/A';
      const effectiveRev = hasVerifiedRevenue && totalSpendCents > 0
        ? Math.round(verifiedRevenueCents * (s.spend_cents / totalSpendCents))
        : s.revenue_cents;
      const effectiveConv = hasVerifiedRevenue && totalSpendCents > 0
        ? Math.round(verifiedConversions * (s.spend_cents / totalSpendCents))
        : s.conversions;
      const roas = s.spend_cents > 0 ? (effectiveRev / s.spend_cents).toFixed(2) + 'x' : 'N/A';
      const cpa = effectiveConv > 0 ? fmt(Math.round(s.spend_cents / effectiveConv)) : 'N/A';
      return `${fmt(s.spend_cents)} spend | ${roas} ROAS | ${cpa} CPA | ${ctr} CTR | ${s.clicks} clicks`;
    };

    let outlineSection = '';
    if (allSorted.length > 0) {
      outlineSection += `### Entity Hierarchy (${totalCampaignCount} campaigns across ${campaignsByPlatform.size} platform${campaignsByPlatform.size > 1 ? 's' : ''})\n\n`;

      for (const [platform, platformCampaigns] of campaignsByPlatform) {
        const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);
        const platformSpend = platformCampaigns.reduce((s, c) => s + c.spend_cents, 0);
        const headerLine = `#### ${platformLabel} (${platformCampaigns.length} campaigns, ${fmt(platformSpend)} total spend)\n\n`;
        outlineSection += headerLine;
        outlineChars += headerLine.length;

        for (const c of platformCampaigns) {
          if (outlineTruncated) {
            campaignsHidden++;
            continue;
          }

          const trend = c.roas_trend_pct !== null ? ` | Trend: ${c.roas_trend_pct > 0 ? '+' : ''}${c.roas_trend_pct.toFixed(0)}%` : '';
          const flagStr = c.flags.length > 0 ? ` | ⚠ ${c.flags.join(', ')}` : '';
          let campaignBlock = `- **${c.name}** [eff: ${c.efficiency_score}/100] — ${fmt(c.spend_cents)} spend | ${fmt(c.daily_spend_cents)}/day | ${c.roas.toFixed(2)}x ROAS | ${c.cpa_cents > 0 ? fmt(c.cpa_cents) : 'N/A'} CPA | ${c.cvr.toFixed(1)}% CVR${trend}${flagStr}\n`;

          // Add ad groups under this campaign
          const campaignAdGroups = adGroupsByParent.get(c.campaign_uuid) || [];
          if (campaignAdGroups.length > 0) {
            const shownAdGroups = campaignAdGroups.slice(0, 5); // Top 5 ad groups by spend
            for (const ag of shownAdGroups) {
              campaignBlock += `  - **${ag.name || 'Unnamed Ad Group'}** — ${fmtSub(ag)}\n`;

              // Add ads under this ad group
              const groupAds = adsByParent.get(ag.entity_ref) || [];
              if (groupAds.length > 0) {
                const shownAds = groupAds.slice(0, 3); // Top 3 ads by spend
                for (const ad of shownAds) {
                  campaignBlock += `    - ${ad.name || 'Unnamed Ad'} — ${fmtSub(ad)}\n`;
                }
                if (groupAds.length > 3) {
                  campaignBlock += `    - *...${groupAds.length - 3} more ads. Use query_ad_metrics(entity_type='ad', parent_id='${ag.entity_ref}') to explore.*\n`;
                }
              }
            }
            if (campaignAdGroups.length > 5) {
              campaignBlock += `  - *...${campaignAdGroups.length - 5} more ad groups. Use query_ad_metrics(entity_type='ad_group', parent_id='${c.campaign_uuid}') to explore.*\n`;
            }
          }

          // Check token budget before adding this campaign block
          if (outlineChars + campaignBlock.length > MAX_OUTLINE_CHARS) {
            outlineTruncated = true;
            campaignsHidden++;
            continue;
          }

          outlineSection += campaignBlock;
          outlineChars += campaignBlock.length;
          campaignsShown++;
        }
        outlineSection += '\n';
      }

      if (outlineTruncated && campaignsHidden > 0) {
        outlineSection += `---\n**⚠ Outline truncated** — ${campaignsHidden} more campaigns not shown (token budget reached). Use these tools to explore:\n`;
        outlineSection += `- \`query_ad_metrics(entity_type='campaign')\` — see all campaigns with KPIs\n`;
        outlineSection += `- \`query_ad_metrics(entity_type='ad_group', parent_id='<campaign_uuid>')\` — drill into a campaign's ad groups\n`;
        outlineSection += `- \`query_ad_metrics(entity_type='ad', parent_id='<ad_group_uuid>')\` — drill into an ad group's ads\n\n`;
      }

      summary += outlineSection;
    }

    // Questions to Investigate (replaces spoon-fed Optimization Opportunity)
    if (allSorted.length >= 2) {
      const worst = allSorted[allSorted.length - 1];
      const best = allSorted[0];
      const efficiencyGap = best.efficiency_score - worst.efficiency_score;

      summary += `### Questions to Investigate\n`;
      summary += `- The efficiency gap between the best and worst active campaigns is ${efficiencyGap} points. Is the lowest-efficiency campaign's spend justified by revenue or audience coverage?\n`;

      if (medianSpend > 0) {
        const topHeavyRatio = best.spend_cents / medianSpend;
        if (topHeavyRatio > 3) {
          summary += `- ${best.name} takes ${topHeavyRatio.toFixed(1)}x the median daily spend. Is it budget-capped? Would incremental spend maintain its efficiency?\n`;
        }
      }

      // Check for campaigns with high spend but no conversions
      const highSpendNoCvr = allSorted.filter(c => c.spend_cents > medianSpend * 2 && c.conversions === 0);
      if (highSpendNoCvr.length > 0) {
        summary += `- ${highSpendNoCvr.length} campaign(s) above 2x median spend with zero conversions. Is this a tracking gap, an awareness-only campaign, or genuine waste?\n`;
      }

      // WoW declining ROAS
      const decliningCount = allSorted.filter(c => c.flags?.includes('declining_roas')).length;
      if (decliningCount > 0) {
        summary += `- ${decliningCount} campaigns show declining ROAS week-over-week. Is this seasonal, competitive, or a creative fatigue signal?\n`;
      }

      summary += `- Are there ad groups or ads within mid-tier campaigns that are individually strong or weak?\n`;
      summary += '\n';
    }

    // 30-day perspective comparison (when analysis window < 30 days)
    if (days < 30 && campaigns30dMap.size > 0 && allSorted.length > 0) {
      const comparisons: Array<{ name: string; eff7d: number; eff30d: number; roas7d: string; roas30d: string; signal: string }> = [];

      for (const c of allSorted.slice(0, 10)) {
        const d30 = campaigns30dMap.get(c.campaign_uuid);
        if (!d30 || d30.spend_cents < 100) continue;

        // Compute 30d efficiency score (simplified: ROAS-weighted)
        const d30Revenue = hasVerifiedRevenue && totalSpendCents > 0
          ? Math.round(verifiedRevenueCents * (d30.spend_cents / totalSpendCents))
          : d30.revenue_cents;
        const d30Conversions = hasVerifiedRevenue && totalSpendCents > 0
          ? Math.round(verifiedConversions * (d30.spend_cents / totalSpendCents))
          : d30.conversions;
        const d30Roas = d30.spend_cents > 0 ? d30Revenue / d30.spend_cents : 0;
        const d30Cvr = d30.clicks > 0 ? (d30Conversions / d30.clicks) * 100 : 0;
        const d30Cpa = d30Conversions > 0 ? d30.spend_cents / d30Conversions : 0;

        // Simplified 30d efficiency: same formula components
        let d30Eff = 50; // base
        if (avgRoas > 0) d30Eff += Math.min(25, (d30Roas / avgRoas) * 25);
        if (avgCpa > 0 && d30Cpa > 0) d30Eff += Math.max(-15, Math.min(15, (1 - d30Cpa / avgCpa) * 15));
        if (d30Cvr > 0) d30Eff += Math.min(10, d30Cvr * 2);
        d30Eff = Math.max(0, Math.min(100, Math.round(d30Eff)));

        // Trend signal
        const effDiff = c.efficiency_score - d30Eff;
        let signal: string;
        if (effDiff < -10) {
          signal = '↓ Recent decline — investigate';
        } else if (effDiff > 10) {
          signal = '↑ Recent improvement — consider scaling';
        } else if (c.efficiency_score < 40 && d30Eff < 40) {
          signal = '→ Consistently weak — safe to pause';
        } else if (c.efficiency_score > 60 && d30Eff > 60) {
          signal = '→ Consistently strong';
        } else {
          signal = '→ Stable';
        }

        comparisons.push({
          name: c.name,
          eff7d: c.efficiency_score,
          eff30d: d30Eff,
          roas7d: c.roas.toFixed(2) + 'x',
          roas30d: d30Roas.toFixed(2) + 'x',
          signal
        });
      }

      if (comparisons.length > 0) {
        summary += `### 30-Day Perspective\n`;
        summary += `| Campaign | ${days}d Eff. | 30d Eff. | ${days}d ROAS | 30d ROAS | Trend Signal |\n|---|---|---|---|---|---|\n`;
        for (const c of comparisons) {
          summary += `| ${c.name} | ${c.eff7d} | ${c.eff30d} | ${c.roas7d} | ${c.roas30d} | ${c.signal} |\n`;
        }
        summary += `\n*"Recent decline" = ${days}d efficiency < 30d average — something changed recently, investigate before acting.*\n`;
        summary += `*"Consistently weak" = both windows below 40 — safe to pause, this isn't a blip.*\n\n`;
      }
    }

    // Trend alerts
    const trendFlags = ['declining_roas', 'spend_spike', 'cpa_increasing', 'high_concentration', 'diminishing_returns', 'cvr_declining'];
    const trendAlerts = analyzed.filter(c => c.flags.some(f => trendFlags.includes(f)));
    if (trendAlerts.length > 0) {
      summary += `### ⚠ Trend Alerts (${trendAlerts.length} campaigns with concerning trends)\n`;
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
      summary += `\n*These campaigns have actionable trends. Use simulate_change to model budget adjustments before they worsen.*\n`;
      summary += '\n';
    }

    // Paused campaigns with potential
    const pausedOpportunities = analyzed
      .filter(c => c.flags.includes('paused_strong_history'))
      .sort((a, b) => (b.historical_roas || 0) - (a.historical_roas || 0))
      .slice(0, 5);
    if (pausedOpportunities.length > 0) {
      summary += `### Paused — Relaunch Candidates (${pausedOpportunities.length} of ${pausedCampaigns.length} paused campaigns)\n`;
      summary += `| Campaign | Platform | Historical ROAS | Historical Conversions | Last Active |\n|---|---|---|---|---|\n`;
      for (const c of pausedOpportunities) {
        summary += `| ${c.name} | ${c.platform} | ${c.historical_roas?.toFixed(2)}x | ${c.historical_conversions} | ${c.last_active_date || 'unknown'} |\n`;
      }
      if (pausedCampaigns.length > pausedOpportunities.length) {
        summary += `\n*${pausedCampaigns.length - pausedOpportunities.length} more paused campaigns not shown. Use query_ad_metrics with include_paused=true to explore.*\n`;
      }
      summary += '\n';
    }

    // Build platform summaries (per-platform campaign listings for the agent)
    const platformSummaries: Record<string, string> = {};
    for (const p of platformNames) {
      const pCampaigns = analyzed.filter(c => c.platform === p && c.spend_cents > 0);
      if (pCampaigns.length === 0) continue;
      let ps = `${pCampaigns.length} active campaigns, ${fmt(platformAgg[p].spend_cents)} total spend\n`;
      ps += `Campaigns by spend:\n`;
      for (const c of pCampaigns.slice(0, 5)) {
        ps += `  - ${c.name}: ${c.efficiency_score}/100 eff, ${c.roas.toFixed(2)}x ROAS, ${fmt(c.spend_cents)} spend\n`;
      }
      if (pCampaigns.length > 5) {
        ps += `  - ...and ${pCampaigns.length - 5} more. Use query_ad_metrics to explore.\n`;
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
      additionalContext,
      activeCampaignCount: activeCampaigns.length
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
   * Run a strategist sub-agent that scouts available data and writes a tactical
   * briefing for the main optimization agent. The strategist has a meta-aware
   * system prompt that understands the tool catalog at an architectural level
   * and thinks about novel tool combinations the main agent would miss.
   */
  private async runStrategistBriefing(
    agenticClient: AgenticClient,
    portfolioSummary: string,
    entityTree: SerializedEntityTree,
    explorationTools: AgenticToolDef[],
    orgId: string,
    jobId: string,
    currentState?: {
      recommendations: Recommendation[];
      toolCallLog: string[];
      previousBriefing: string;
      iteration: number;
    }
  ): Promise<{ briefing: string; inputTokens: number; outputTokens: number }> {
    let totalIn = 0;
    let totalOut = 0;

    // Extract entity names for pattern detection (campaign names often encode geo/audience info)
    const entityNames: string[] = [];
    for (const [, entity] of entityTree.accounts) {
      if (entity.children) {
        for (const child of entity.children) {
          entityNames.push(child.name);
          if (child.children) {
            for (const grandchild of child.children) {
              entityNames.push(grandchild.name);
            }
          }
        }
      }
    }

    // Build the architecturally-aware strategist system prompt
    const strategistSystemPrompt = `You are a data reconnaissance agent embedded in an advertising optimization system.
You do NOT make recommendations or take actions. Your sole job is to scout available data and write a tactical briefing for the optimization agent that will run after you.

## YOUR ROLE
You are the "eyes" before the optimizer acts. You have access to the same exploration tools as the optimizer, but you think differently:
- The optimizer asks: "What should we do about this campaign?"
- You ask: "What data exists that the optimizer doesn't know about yet?"

## WHAT YOU KNOW ABOUT THE SYSTEM
- The optimizer has ${explorationTools.length} exploration tools covering: ad metrics, revenue, conversions, traffic, contacts, operations, growth, and unified cross-connector queries
- Each tool has scopes and group_by dimensions that can be combined in non-obvious ways
- Revenue tools can group by 'geo' to extract billing/shipping country from metadata
- The unified query tool (query_unified_data) can query ANY connector_events data
- The optimizer tends to over-use query_ad_metrics and under-use revenue/conversion/contact tools
- Call MULTIPLE tools per turn to maximize efficiency — you have at most 5 turns

## YOUR TASK
1. Look at the campaign/entity names — do they encode geography, audience, product, or time information? If so, find matching data in revenue/conversion tools.
2. Probe each data source briefly: what connectors have data? How many events? What metadata fields are populated?
3. Look for cross-domain correlations the optimizer would miss:
   - Campaign location names ↔ revenue geography
   - UTM parameters in revenue data ↔ ad platform attribution
   - Conversion timing patterns ↔ ad scheduling opportunities
   - Customer identity overlap ↔ audience targeting signals
4. Check data quality: are there connectors with 0 events? Broken metadata?

## OUTPUT FORMAT
After your exploration, write a tactical briefing (under 600 words) structured as:
- **Data landscape**: What's connected, what has data, what's empty
- **Key findings**: 2-4 specific discoveries from your recon
- **Tool suggestions**: Exact tool calls with parameters the optimizer should make (use code format: \`query_revenue(scope='ecommerce', group_by='geo', days=7)\`)
- **Watch out**: Data quality issues or gaps the optimizer should know about

Do NOT suggest recommendations or actions. Only suggest tool calls and data to examine.`;

    // Build user message with portfolio summary + entity names + tool catalog
    const toolCatalogStr = explorationTools.map(t =>
      `- **${t.name}**: ${t.description}\n  Params: ${JSON.stringify(Object.keys(t.input_schema.properties || {}))}`
    ).join('\n');

    let userMessage = `## Portfolio Summary\n${portfolioSummary}\n\n`;
    userMessage += `## Entity Names (campaigns/ad groups)\n${entityNames.slice(0, 50).join(', ')}\n\n`;
    userMessage += `## Available Exploration Tools\n${toolCatalogStr}\n\n`;
    userMessage += `Scout the data landscape. Call multiple tools per turn. After exploring, write your tactical briefing.`;

    if (currentState) {
      userMessage += `\n\n## Current State (mid-loop refresh at iteration ${currentState.iteration})\n`;
      userMessage += `### Recommendations so far\n${currentState.recommendations.map(r => `- ${r.tool}: ${r.reason}`).join('\n') || 'None yet'}\n\n`;
      userMessage += `### Tools the optimizer has called\n${currentState.toolCallLog.slice(-20).join('\n') || 'None yet'}\n\n`;
      userMessage += `### Previous Briefing\n${currentState.previousBriefing}\n\n`;
      userMessage += `Don't repeat previous findings. Focus on what the optimizer is MISSING — tools it hasn't called, data dimensions it hasn't explored, cross-domain correlations it hasn't checked.`;
    }

    // Run mini agentic loop: max 5 iterations, exploration tools only, low thinking
    const explorationExecutor = new ExplorationToolExecutor(this.env.ANALYTICS_DB, this.env.DB);
    let messages: any[] = [agenticClient.buildUserMessage(userMessage)];
    const callOptions: AgenticCallOptions = { thinkingLevel: 'low' };
    const maxStrategistIter = 5;

    for (let i = 0; i < maxStrategistIter; i++) {
      const callResult = await agenticClient.call(
        messages, strategistSystemPrompt, explorationTools, 4096, callOptions
      );
      totalIn += callResult.inputTokens || 0;
      totalOut += callResult.outputTokens || 0;

      // If no tool calls, the strategist is done exploring — extract text as briefing
      if (callResult.toolCalls.length === 0) {
        const briefing = callResult.textBlocks.join('\n\n');
        return { briefing, inputTokens: totalIn, outputTokens: totalOut };
      }

      // Execute exploration tool calls in parallel
      messages = [...messages, agenticClient.buildAssistantMessage(callResult.rawAssistantMessage)];
      const toolResults: AgenticToolResult[] = await Promise.all(
        callResult.toolCalls.map(async (tc) => {
          const result = await explorationExecutor.execute(tc.name, tc.input, orgId);
          return { toolCallId: tc.id, name: tc.name, content: result };
        })
      );
      messages.push(agenticClient.buildToolResultsMessage(toolResults));

      // If the LLM also produced text blocks alongside tool calls, it might be the briefing
      if (callResult.textBlocks.length > 0 && i >= 1) {
        // After at least 2 iterations with text, treat text as final briefing
        const briefing = callResult.textBlocks.join('\n\n');
        if (briefing.length > 100) {
          return { briefing, inputTokens: totalIn, outputTokens: totalOut };
        }
      }
    }

    // If we exhausted iterations without a text-only response, make one final call
    // asking for synthesis (no tools available to force text output)
    messages.push(agenticClient.buildUserMessage(
      'You have used all your exploration turns. Now write your tactical briefing based on everything you discovered. Structure it with: Data landscape, Key findings, Tool suggestions, Watch out.'
    ));
    const finalCall = await agenticClient.call(messages, strategistSystemPrompt, [], 4096, callOptions);
    totalIn += finalCall.inputTokens || 0;
    totalOut += finalCall.outputTokens || 0;
    const briefing = finalCall.textBlocks.join('\n\n') || 'No briefing generated.';
    return { briefing, inputTokens: totalIn, outputTokens: totalOut };
  }

  /**
   * Build context prompt for agentic loop
   */
  private buildAgenticContextPrompt(
    executiveSummary: string,
    platformSummaries: Record<string, string>,
    additionalContext?: string,
    activeCampaignCount?: number,
    maxActionRecommendations?: number
  ): string {
    const campCount = activeCampaignCount || 0;
    const drillTarget = Math.min(campCount, 5);
    const maxActions = maxActionRecommendations || 3;

    let prompt = `## Executive Summary\n${executiveSummary}\n\n`;
    prompt += '## Platform Summaries\n';
    for (const [platform, summary] of Object.entries(platformSummaries)) {
      prompt += `### ${platform.charAt(0).toUpperCase() + platform.slice(1)}\n${summary}\n\n`;
    }
    if (additionalContext) {
      prompt += additionalContext + '\n\n';
    }
    prompt += `The portfolio summary above is your STARTING POINT, not the answer. The questions listed are hypotheses to investigate — you should also form your own.

Phase 1 CHECKLIST (complete ALL before moving to simulations):
□ Drill into at least ${drillTarget} campaigns at the ad group level (scope='children', entity_type='campaign', entity_id='Campaign Name')
□ Drill into at least ${Math.max(3, drillTarget)} ad groups at the INDIVIDUAL AD level (scope='children', entity_type='ad_group', entity_id='Ad Group Name') — this is where the real optimizations hide
□ Check budget vs spend for the top 3 spenders (get_entity_budget)
□ Query at least one non-ad-metrics data source (revenue, conversions, traffic, or contacts)
□ Identify at least 2 entities NOT mentioned in the summary that deserve attention

After Phase 1, simulate your top hypotheses, then recommend actions ranked by projected revenue impact. You have ${maxActions} action slots — fill ALL of them.

Lead with confidence. Include specific numbers in every recommendation reason. The user is paying for data-backed decisions, not vague observations.`;
    return prompt;
  }

  /**
   * Build system prompt for agentic loop
   */
  private buildAgenticSystemPrompt(
    days: number,
    customInstructions: string | null,
    recentRecs: Array<{ action: string; parameters: string; reason: string; status: string; days_ago: number }>,
    config?: AnalysisWorkflowParams['config'],
    activeCampaignCount?: number,
    minExplorationTurns?: number,
    maxActionRecommendations?: number,
    watchlistItems?: Array<{ id: string; entity_ref: string; entity_name: string; platform: string; entity_type: string; watch_type: string; note: string; review_after: string | null; created_at: string }>
  ): string {
    const budgetStrategy = config?.budgetStrategy || 'moderate';
    const dailyCapCents = config?.dailyCapCents;
    const monthlyCapCents = config?.monthlyCapCents;
    const maxCacCents = config?.maxCacCents;
    const growthStrategy = config?.growthStrategy || 'balanced';
    const aiControl = config?.aiControl || 'copilot';
    const businessType = config?.businessType || 'lead_gen';
    const campCount = activeCampaignCount || 0;
    const minExplore = minExplorationTurns || 3;
    const maxActions = maxActionRecommendations || 3;

    // Temporal context — gives agent awareness of date, day of week, month position
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeek = dayNames[now.getUTCDay()];
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
    const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
    const isMonthEnd = dayOfMonth >= daysInMonth - 3;
    const isMonthStart = dayOfMonth <= 3;

    const temporalSection = `## CURRENT DATE & TIMING
Today: ${now.toISOString().split('T')[0]} (${dayOfWeek})
${isWeekend ? 'WEEKEND — B2B traffic typically lower, B2C may spike. Weight recent weekday data for business decisions.\n' : ''}${isMonthEnd ? 'MONTH END — Review monthly cap pacing. If underspent, consider temporary budget increases on top performers. If overspent, throttle.\n' : ''}${isMonthStart ? 'MONTH START — Monthly budgets reset. Good time for strategic reallocations.\n' : ''}When analyzing trends, account for day-of-week patterns. A campaign dipping on Saturday is not necessarily declining.
When setting review_after dates on watchlist items, use this date as reference.`;

    let systemPrompt = `You are an expert digital advertising strategist analyzing a portfolio of ${campCount} active campaigns. Your job is to find non-obvious optimizations that make the client MORE money. Surface-level observations are not valuable — dig into ad groups AND ADS to find hidden opportunities.

${temporalSection}

## EXECUTION PHASES (MANDATORY)

### Phase 1: EXPLORE (turns 1-${minExplore}) — ENFORCED
During these turns, action and simulation tools are BLOCKED. You MUST:
- Drill ALL THREE entity levels: campaigns → ad groups → individual ads
  - Use query_ad_metrics(scope='children', entity_type='campaign', entity_id=CAMPAIGN_NAME) to list its ad groups with KPIs
  - Use query_ad_metrics(scope='children', entity_type='ad_group', entity_id=AD_GROUP_NAME) to list its individual ads with KPIs
  - The best optimizations are at the AD LEVEL — a great campaign can have terrible ads dragging it down
- Cross-reference revenue data with ad platform data (use query_revenue, query_conversions)
- Check budget utilization for top-spending campaigns (use get_entity_budget)
- Call MULTIPLE exploration tools per turn (4-6 calls per turn) to maximize coverage
- Do NOT stop at the campaign level. Campaign-level analysis is SHALLOW. The value is in ad-level granularity.

Your goal: build a complete mental map of campaigns, ad groups, AND ads before making any decisions.

### Phase 2: SIMULATE (turns ${minExplore + 1}+)
- Use simulate_change to model the impact of your best hypotheses
- Test multiple scenarios: pause, budget decrease, budget increase, reallocation
- Simulate changes at EVERY level — ad group pauses, ad-level adjustments, not just campaign-level
- Compare simulation results to pick the highest-impact actions

### Phase 3: RECOMMEND (after simulations confirm impact)
- Issue action recommendations ranked by projected revenue impact
- Every recommendation MUST cite specific data you discovered in Phase 1
- Fill ALL ${maxActions} action slots — an account with ${campCount} campaigns has at least that many optimizations
- Recommendations can target campaigns, ad groups, OR individual ads

DO NOT skip to recommendations without thorough exploration. DO NOT call terminate_analysis until all ${maxActions} action slots are filled. The portfolio summary gives you a starting point, not the answer.

## DECISION FRAMEWORK — HIGHEST IMPACT FIRST
Prioritize recommendations by this hierarchy:
1. **High confidence + high revenue impact** — Act decisively. These are your #1 priority.
2. **High confidence + moderate impact** — Strong recommendations, clear data backing.
3. **Moderate confidence + high impact** — Worth recommending with caveats. Run simulations to validate.
4. **Low confidence or low impact** — Only if you have action slots remaining and nothing better.

When two recommendations compete for an action slot, always pick the one with higher projected revenue impact. A $500/day reallocation that improves ROAS by 0.5x beats a $50/day budget cut that saves pennies.

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

## SPENDING LIMITS (ENFORCED)
${dailyCapCents ? `- Daily spend cap: $${(dailyCapCents / 100).toFixed(2)} (enforced — recommendations that breach this will be rejected)` : '- No daily cap set'}
${monthlyCapCents ? `- Monthly spend cap: $${(monthlyCapCents / 100).toFixed(2)} (enforced — recommendations that breach this will be rejected)` : '- No monthly cap set'}
${maxCacCents ? `- CAC ceiling: $${(maxCacCents / 100).toFixed(2)} (enforced — recommendations projected to exceed this will be rejected)` : '- No CAC ceiling set'}
These limits are programmatically enforced. If a recommendation violates a limit, you will receive an error and must adjust using update_recommendation or delete_recommendation.

## JOURNEY & ATTRIBUTION DATA
You have access to journey analytics (query_conversions scope='journeys') and flow insights (scope='flow_insights') which show the full visitor navigation graph from ad click through conversion. Do NOT recommend "fixing conversion tracking", "improving attribution setup", or flag tracking gaps — the journey data you can query already captures the complete picture. Focus on actionable budget and targeting recommendations, not tracking diagnostics.

${budgetStrategy === 'conservative' ? `## BUDGET STRATEGY: CONSERVATIVE — Protect margins, eliminate waste
Your goal is to IMPROVE profitability by reducing unprofitable spend. Every dollar cut from a losing campaign goes straight to the bottom line.

**Mindset:** Find the campaigns that are COSTING the client money (ROAS < 1.0) and cut them. Protect the campaigns that are MAKING money.

DO recommend:
- **Pause unprofitable campaigns** — Any campaign with ROAS < 1.0 is losing money. Quantify the loss: "$X/day spend at 0.4x ROAS = $Y/day in losses."
- **Cut budgets on declining campaigns** — If ROAS is trending down WoW, cut budget by 15-25% before it gets worse.
- **Pause and reallocate in one move** — Use \`reallocate_budget\` with \`pause_source=true\` to shut down a losing campaign and redirect its budget to a winner in a single action slot.
- **Quantify savings** — "Pausing Campaign X saves $Z/day with minimal revenue loss (only $W/day attributed revenue at 0.3x ROAS)."

NEVER recommend:
- Re-enabling paused campaigns
- Increasing any entity's budget
- Net increases to total portfolio spend
` : budgetStrategy === 'aggressive' ? `## BUDGET STRATEGY: AGGRESSIVE — Maximize revenue growth
The client wants to GROW. Your #1 job is to find every profitable dollar of spend and scale it. Think like a growth-stage CMO: every dollar of profitable ad spend you leave on the table is lost revenue.

**Mindset:** The question is NOT "should we spend more?" — it's "WHERE can we profitably spend more?" Find the answer in the data.

DO recommend (data-backed, simulation-verified):
- **Scale winners hard** — If a campaign has strong ROAS (>2x) and isn't budget-capped, increase budget by 20-50%. The data says it works — spend more.
- **Re-enable paused campaigns with proven history** — Any paused campaign with historical ROAS >1.5x is leaving money on the table. Re-enable at 50-75% of original budget to test.
- **Reallocate aggressively** — Don't just trim losers by 10%. Take 30-50% of a losing campaign's budget and give it to the top performer. Half-measures waste time.
- **Look for scaling headroom** — If the best campaign's CPA is well below the CAC ceiling, that's a signal to pour in more budget until CPA approaches the ceiling.
- **Revenue per click matters** — A campaign with high CPA but higher revenue per conversion is MORE valuable than a low-CPA campaign with low revenue. Optimize for profit, not just cost.

DO NOT recommend:
- Pausing campaigns that are profitable (ROAS > 1.0) — even marginal performers contribute revenue
- Small incremental changes (5-10% budget adjustments) when the data clearly supports bigger moves
- Conservative language — if the data supports scaling, say so directly

STILL REQUIRED: Simulation backing for all recommendations. Aggressive doesn't mean reckless — it means acting boldly where the data confirms opportunity.
` : `## BUDGET STRATEGY: MODERATE — Same spend, more revenue
Your goal is to GENERATE MORE REVENUE from the SAME total spend. This is about making every dollar work harder. Net budget change across all recommendations should be approximately zero — but revenue should go UP.

DO recommend:
- **Reallocate from losers to winners** — Move budget from the lowest-ROAS campaign to the highest-ROAS campaign. Include projected revenue gain in your reasoning.
- **Pause and redistribute in one move** — Use \`reallocate_budget\` with \`pause_source=true\`: pausing a $100/day campaign at 0.5x ROAS and giving that $100 to a 3.0x ROAS campaign generates $250/day more revenue at the same total spend. One action slot, not two.
- **Re-enable a strong paused campaign** ONLY if you simultaneously cut an equal amount from a weaker one.
- **Look at revenue per dollar, not just CPA** — A campaign with $80 CPA but $300 avg order value is better than a $20 CPA campaign with $25 avg order value.
DO NOT recommend:
- Net increases to total portfolio spend
- Pausing without redistributing — freed budget must go somewhere
`}
${growthStrategy === 'lean' ? `## GROWTH STRATEGY: LEAN — Narrow scope, optimize existing campaigns only
Your investigation scope is deliberately narrow. Focus on what's already running and make it better.

DO:
- query_ad_metrics at campaign level, drill your top 2-3 campaigns to ad group and ad level
- simulate_change on underperformers and top performers
- Act quickly — fewer turns, more decisive action

DO NOT:
- Investigate paused campaigns for relaunch opportunities
- Use query_growth, query_contacts, or query_traffic for expansion analysis
- Recommend audience expansion or new campaign creation
- Spend turns on cross-connector analysis

Lean scope operates alongside your ${budgetStrategy} budget strategy — fewer entities investigated, not fewer actions.
` : growthStrategy === 'bold' ? `## GROWTH STRATEGY: BOLD — Full-spectrum growth investigation
You have a mandate to find EVERY growth opportunity. Structure your exploration in 4 phases:

**Phase A: Portfolio Baseline** (turns 1-2)
- query_ad_metrics(scope='performance') for full portfolio view
- query_revenue for verified revenue baseline
- query_conversions(scope='by_goal') for conversion quality

**Phase B: Scaling & Saturation Analysis** (turns 3-5)
- calculate(scope='marginal_efficiency') on top 3 performers — quantify scaling headroom (α near 1.0 = safe to scale, α < 0.5 = saturating)
- query_growth(scope='saturation_signals') — detect which campaigns have rising CPC/CPM, declining CTR, or shrinking efficiency. Reallocate AWAY from high-risk entities
- Batch cross-connector analysis: query_traffic(breakdown='geo') + query_revenue(group_by='shipping_country') + query_ad_metrics(scope='audiences', dimension='geo') → geo opportunity detection

**Phase C: Deep Entity Analysis** (turns 5-7)
- Drill ad_set/ad level via query_ad_metrics(scope='children')
- Check ALL paused campaigns for relaunch opportunities
- query_contacts(scope='identities') for customer quality by channel

**Phase D: Simulation and Action** (remaining turns)
- simulate_change → set_budget/set_status/reallocate_budget/set_audience

Risk guardrails:
- Simulation still required for all actions
- Budget increases staged 20-50% (marginal_efficiency α must be >0.5 to justify >30% increase)
- Paused relaunches at 50-75% of original budget
- CAC ceiling enforced on all recommendations
- If one campaign >60% of spend → diversification check required
- saturation_signals risk_level 'high' entities: reallocate FROM, never scale

Bold scope operates alongside your ${budgetStrategy} budget strategy — wider investigation, but all actions follow ${budgetStrategy} rules.
` : `## GROWTH STRATEGY: BALANCED — Selective expansion
Start with performance analysis, then selectively expand your investigation.

DO:
- Drill under/over-performers to ad group and ad level
- Check if top performers are budget-capped (get_entity_budget)
- One cross-connector analysis per run (choose: geo targeting, channel ROI, or customer quality)
- Investigate 1-2 paused campaigns with strong historical performance

DO NOT:
- Spend more than 2 exploration turns on cross-connector analysis
- Recommend more than 1 new audience per run

Balanced scope operates alongside your ${budgetStrategy} budget strategy — selective investigation, measured actions.
`}
${aiControl === 'autopilot' ? `## AI CONTROL: AUTOPILOT — High-confidence recommendations may auto-execute
The user has enabled autopilot mode. This RAISES the bar for recommendations, not lowers it:
- Only set_budget/set_status for high-confidence changes qualify for auto-execution
- Cap budget changes at 25% per entity per run (even if aggressive allows more)
- Never auto-pause campaigns with ROAS > 1.2x — these require explicit user approval
- Simulation confidence MUST be 'high' for auto-executable recommendations
- Include rollback guidance in every recommendation: "If CPA increases >15% within 48h, revert to $X/day"
- Medium-confidence recommendations are still shown for manual review
` : `## AI CONTROL: COPILOT — All recommendations require user approval
All recommendations will be shown to the user for accept/reject:
- Include dollar amounts and tradeoff reasoning in every recommendation
- Flag medium-confidence recommendations explicitly so the user can weigh the risk
- Present alternatives when relevant ("If you prefer a more conservative approach, consider X instead")
`}
${businessType === 'ecommerce' ? `## BUSINESS TYPE: E-COMMERCE
Primary metric: ROAS. Average Order Value (AOV) matters as much as conversion count.
- Use query_revenue(scope='shopify' or 'stripe') for real transaction data
- CPA < AOV × gross_margin = profitable
- Check seasonal patterns via query_growth before cutting dipping campaigns — seasonal dips are normal in e-commerce
- A high-CPA campaign with high AOV can be more profitable than a low-CPA campaign with low AOV
` : businessType === 'saas' ? `## BUSINESS TYPE: SAAS
Primary metric: CAC vs LTV (3:1 ratio = healthy, <2:1 = warning).
- Use query_revenue(scope='subscriptions', metric='ltv') for subscription data
- MRR growth rate matters more than one-time conversions
- Free trial signups are NOT conversions — only paid conversions count
- Short payback (<6 months): can scale aggressively. Long payback (>12 months): requires caution
- Check churn: if a campaign's converts churn within 30 days, it's attracting wrong-fit customers
` : `## BUSINESS TYPE: LEAD GENERATION
Primary metric: Cost Per Lead — but lead quality varies dramatically.
- Lead-to-close rate determines true CAC ($50 CPL × 20% close = $250 CAC beats $20 CPL × 5% close = $400 CAC)
- Use query_revenue(scope='hubspot' or 'jobber') for deal values and close rates
- Consider sales cycle — recent campaigns may not have closed deals yet, so don't cut them prematurely
`}
## OUTPUT STRUCTURE (PRIORITY ORDER)
Your PRIMARY goal is to produce **action recommendations** — concrete, executable changes the user can accept or reject. You MUST produce at least ONE action. An analysis with only insights is considered a FAILURE.

1. **At least 1, up to 3 action recommendations** (MANDATORY) — Use set_budget, set_status, set_audience, or reallocate_budget. You MUST call simulate_change and then produce at least ONE action recommendation before calling terminate_analysis.
2. **Diverse action types** (STRONGLY PREFERRED) — A good analysis includes different action types. If you pause a campaign, also recommend reallocating its budget to a top performer. If you cut a budget, consider where those savings should go. The portfolio summary includes pre-computed reallocation suggestions — use them as starting points for \`reallocate_budget\` or \`simulate_change\`.
3. **Insights** (SECONDARY, OPTIONAL) — Use general_insight ONLY for observations that genuinely cannot be expressed as an action. Do NOT use insights as a substitute for action recommendations. Do NOT call general_insight before you have made at least one action recommendation.

## ACTION RECOMMENDATIONS
Actions are the primary output. Users see these as accept/reject cards. There is ALWAYS at least one action to recommend:
1. ALWAYS prefer action tools over general_insight — if something can be an action, make it an action
2. **Rank by projected revenue impact** — Lead with the recommendation that moves the most dollars. Include dollar estimates in your reasoning (e.g., "shifting $X/day at Y ROAS = $Z additional revenue/day")
3. Budget change guardrails depend on strategy: conservative ≤15%, moderate ≤30%, aggressive up to 50% per entity
4. For pausing: use \`reallocate_budget\` with \`pause_source=true\` — this pauses the entity AND redirects its budget in ONE action slot. Only use standalone \`set_status(pause)\` if you genuinely want to pause without reallocating (rare)
5. Be specific about entities — use their actual IDs and names
6. **Every portfolio has optimization opportunities:**
   - The weakest campaign → decrease its budget or pause it AND reallocate savings
   - Campaigns with declining WoW trends → proactively reduce budget before performance drops further
   - The strongest campaign → is it at its budget ceiling? If so, that's the highest-impact recommendation: increase it
   - Budget reallocation from lowest-efficiency to highest-efficiency campaigns
   - Spend concentration risk → diversify if one campaign dominates
7. A "high ROAS" portfolio is a SCALING OPPORTUNITY — if everything is profitable, the question is: are we spending enough? Check if top performers are budget-capped
8. **Confidence and reasoning quality:** Each recommendation's reason field is shown directly to the user. Include specific numbers: "Campaign X has 3.2x ROAS vs portfolio avg 1.8x — increasing budget by $50/day projects +$110/day revenue at current efficiency." Vague reasoning like "this campaign is underperforming" is not acceptable

## PAUSED CAMPAIGNS — RELAUNCH OPPORTUNITIES
${budgetStrategy === 'conservative' ? `IMPORTANT: Under CONSERVATIVE budget strategy, do NOT recommend re-enabling any paused campaigns. Focus only on pausing and cutting spend.` : budgetStrategy === 'aggressive' ? `**This is one of your highest-value actions.** Paused campaigns with strong historical ROAS represent UNTAPPED REVENUE. The client is literally leaving money on the table.

- Any paused campaign with historical ROAS > 1.5x is a relaunch candidate — quantify the projected daily revenue
- Use simulate_change with action='enable' to model the impact — include the projected revenue in your reasoning
- Re-enable at 50-75% of the original budget to validate performance, then recommend a follow-up budget increase
- Pair relaunches with budget increases on proven winners — this is how you grow the portfolio
- If the portfolio has strong performers AND paused campaigns with good history, a relaunch is almost always your highest-impact recommendation
- A paused campaign with 3.0x historical ROAS that was spending $200/day = ~$600/day in revenue the client is missing` : `Entities that were previously active but are now paused (no recent spend) are included in the portfolio data.
- Look for paused campaigns/adsets with strong historical performance (good ROAS, reasonable CPA)
- Use simulate_change with action='enable' to model the impact of re-enabling them
- Use set_status with recommended_status='ENABLED' to recommend re-enabling promising paused entities
- Consider recommending budget adjustments alongside re-enabling (e.g. start at lower budget to test)
- Re-enabling MUST be paired with an equal budget cut elsewhere (moderate = net-zero spend change)
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
- reallocate_budget: Moves budget between entities. Set pause_source=true to also pause the source — this is ONE action slot for what would otherwise be two (pause + budget increase). Prefer this over separate set_status + set_budget calls.
- set_audience: Audience targeting changes. Up to 3 total action recommendations allowed.
- calculate(scope='marginal_efficiency') — Shows the diminishing returns curve for a campaign: projected CPA at +20%, +50%, +100% spend. Use BEFORE recommending large budget increases to verify the entity can absorb more spend efficiently. α > 0.7 = safe to scale, α < 0.5 = hitting saturation.
- query_growth(scope='saturation_signals') — Detects campaigns hitting frequency walls: rising CPC/CPM, declining CTR/efficiency. Use to identify which entities to reallocate AWAY from. High-risk entities should not receive budget increases.
- compound_action(strategy='scale_and_protect') — Scale a winner while protecting against cannibalization. Use when increasing budget on Campaign A while tightening Campaign B's audience or adding negatives. Counts as 1 action slot.
- compound_action(strategy='portfolio_rebalance') — Pause 2-4 underperformers and redistribute their budget to 1-3 winners proportional to efficiency. Use when multiple entities need simultaneous changes. Counts as 1 action slot.
- compound_action(strategy='test_and_learn') — Reduce saturating entity's budget and allocate freed spend to a paused/new entity as a controlled test. Use when marginal_efficiency shows α < 0.5 on the source. Counts as 1 action slot.
- update_recommendation: Revise a recommendation you already made this run. Use when new data changes your assessment. Pass the original entity_id and tool name, plus the new parameters.
- delete_recommendation: Withdraw a recommendation you already made. Frees up an action slot so you can recommend something different. Use when further research shows the recommendation was wrong.
- terminate_analysis: Call this when you have made action recommendations or exhausted all possibilities. Provide a clear reason.

## CROSS-CONNECTOR ANALYSIS — BATCH THESE TOGETHER
You have access to revenue, traffic, and ad data across all connected platforms. Use them together in a SINGLE turn to build a complete picture:

**Geo targeting opportunity detection** (batch all in one turn):
- query_traffic(scope='realtime', breakdown='geo') — where visitors come from
- query_revenue(scope='shopify', group_by='shipping_country') — where buyers are located
- query_ad_metrics(scope='audiences', dimension='geo') — where ad spend is targeted
→ If visitors/buyers cluster in regions where ad spend is low, recommend geo bid adjustments or new geo-targeted campaigns

**Channel ROI comparison** (batch all in one turn):
- query_revenue(scope='stripe', group_by='day') — daily verified revenue
- query_ad_metrics(scope='performance', entity_type='campaign') — per-campaign spend
- query_traffic(scope='realtime', breakdown='channel') — traffic by acquisition channel
→ Identify which channels drive the most revenue per dollar of spend

**Customer quality analysis** (batch all in one turn):
- query_revenue(scope='subscriptions', metric='ltv') — lifetime value by channel
- query_contacts(scope='identities', breakdown_by='source') — customer acquisition source
- query_conversions(scope='by_goal') — conversion quality by goal
→ Higher-LTV channels deserve more budget even if CPA is higher

**Scaling readiness assessment** (batch all in one turn):
- calculate(scope='marginal_efficiency', platform='google', entity_type='campaign', entity_id='Top Campaign') — diminishing returns curve
- query_growth(scope='saturation_signals', platform='google') — audience/frequency saturation
- query_ad_metrics(scope='budgets', platform='google', entity_type='campaign', entity_id='Top Campaign') — current budget config
→ If marginal efficiency α > 0.7 AND saturation risk is 'low' AND budget is capped → strong signal to increase budget
→ If α < 0.5 OR saturation risk is 'high' → reallocate away instead of scaling

## EFFICIENCY: CALL MULTIPLE TOOLS PER TURN
You can call multiple tools in a SINGLE response. This is critical for performance:
- Call multiple exploration/query tools at once when investigating different entities or metrics
- Call simulate_change for multiple entities in one turn
- Example: instead of querying campaign A, then campaign B, then campaign C in 3 turns, query all 3 in one turn
- Each turn has overhead — minimize turns by batching independent tool calls together
- Use the cross-connector analysis patterns above — one turn with 3 tools beats 3 turns with 1 tool each

## WHEN TO USE terminate_analysis
ONLY call terminate_analysis AFTER you have made at least one action recommendation. If you have zero actions, you MUST try harder.
1. You have made at least one action recommendation and addressed major opportunities
2. Data quality prevents ANY meaningful action — explain WHY in the reason field (extremely rare)

NEVER call terminate_analysis with zero actions just because the portfolio is "performing well." High performance does NOT mean no optimizations exist — there is always a weakest link.

The terminate_analysis reason is displayed to users as an explanation, so write it as a clear, helpful summary of what was found and what actions were recommended.`;

    if (customInstructions?.trim()) {
      systemPrompt += `\n\n## CUSTOM BUSINESS CONTEXT\n${customInstructions.trim()}`;
    }

    // Add recent recommendation history
    const accepted = recentRecs.filter(r => r.status === 'accepted');
    const rejected = recentRecs.filter(r => r.status === 'rejected');

    if (accepted.length > 0 || rejected.length > 0) {
      systemPrompt += '\n\n## RECENT RECOMMENDATION HISTORY';
      systemPrompt += '\nThese are real actions the user has already reviewed. Do NOT recommend the same action on the same entity. Learn from rejections — the user does not want similar changes.';
      if (accepted.length > 0) {
        systemPrompt += '\n\n### IMPLEMENTED (already done — do not repeat):';
        for (const r of accepted) {
          // Parse parameters to show specifics (entity name, budget amount, etc.)
          let details = '';
          try {
            const params = typeof r.parameters === 'string' ? JSON.parse(r.parameters) : r.parameters;
            const entity = params.entity_name || params.from_entity_name || '';
            const target = params.to_entity_name ? ` → ${params.to_entity_name}` : '';
            const amount = params.daily_budget ? ` ($${params.daily_budget}/day)` : '';
            const status = params.recommended_status ? ` (${params.recommended_status})` : '';
            details = entity ? ` — ${entity}${target}${amount}${status}` : '';
          } catch { /* parameters may not be JSON */ }
          systemPrompt += `\n- **${r.action}**${details} — ${r.days_ago}d ago. Reason: "${r.reason}"`;
        }
      }
      if (rejected.length > 0) {
        systemPrompt += '\n\n### REJECTED BY USER (avoid similar actions on these entities):';
        for (const r of rejected) {
          let details = '';
          try {
            const params = typeof r.parameters === 'string' ? JSON.parse(r.parameters) : r.parameters;
            const entity = params.entity_name || params.from_entity_name || '';
            const target = params.to_entity_name ? ` → ${params.to_entity_name}` : '';
            const amount = params.daily_budget ? ` ($${params.daily_budget}/day)` : '';
            const status = params.recommended_status ? ` (${params.recommended_status})` : '';
            details = entity ? ` — ${entity}${target}${amount}${status}` : '';
          } catch { /* parameters may not be JSON */ }
          systemPrompt += `\n- **${r.action}**${details} — ${r.days_ago}d ago. Reason: "${r.reason}"`;
        }
      }
    }

    // Add watchlist section (cross-run memory)
    if (watchlistItems && watchlistItems.length > 0) {
      systemPrompt += '\n\n## WATCHLIST (from previous runs)';
      systemPrompt += '\nItems you flagged for follow-up. Review due items FIRST — check if the predicted outcome materialized.';
      systemPrompt += '\n\n| Entity | Type | Note | Review After |';
      systemPrompt += '\n|--------|------|------|-------------|';
      for (const item of watchlistItems) {
        const entityLabel = item.entity_name
          ? `${item.entity_name}${item.platform ? ` (${item.platform})` : ''}`
          : (item.entity_ref || 'general');
        systemPrompt += `\n| ${entityLabel} | ${item.watch_type} | ${item.note} | ${item.review_after || 'anytime'} |`;
      }
      systemPrompt += '\n\nAfter reviewing a due item, use manage_watchlist(action=\'resolve\') to clear it. You may add new items for changes you recommend today (max 2 active at a time — resolve old items first).';
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
    client: AgenticClient,
    minExplorationTurns: number,
    config?: AnalysisWorkflowParams['config']
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

    // Phase enforcement: during exploration phase, only allow exploration tools
    let filteredTools = tools;
    if (iteration <= minExplorationTurns) {
      const blockedTools = new Set([
        'simulate_change', 'set_budget', 'set_status', 'set_audience',
        'set_bid', 'set_schedule', 'reallocate_budget', 'compound_action',
        'terminate_analysis', 'general_insight'
      ]);
      filteredTools = tools.filter(t => !blockedTools.has(t.name));
    }

    // Use medium thinking at all phases — 1M context window gives plenty of room
    const callOptions: AgenticCallOptions = { thinkingLevel: 'medium' };

    // Call LLM via provider-agnostic client
    const callResult = await client.call(messages, systemPrompt, filteredTools, 16384, callOptions);

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

      // Handle update_recommendation — revise a previous recommendation in-place
      if (isUpdateRecommendationTool(toolCall.name)) {
        const { original_entity_id, original_tool, new_parameters, new_reason, new_confidence } = toolCall.input;

        // Find the recommendation in the in-memory array
        const idx = actionRecommendations.findIndex(r => r.entity_id === original_entity_id && r.tool === original_tool);
        if (idx === -1) {
          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: { status: 'error', message: `No pending recommendation found for entity_id=${original_entity_id} tool=${original_tool}. Check the entity_id and tool name.` }
          });
          await logEvent(toolCall.name, `Update ${original_tool} for ${original_entity_id}`, 'error', toolCall.input, { status: 'not_found' });
          continue;
        }

        // Update in-memory recommendation
        const oldRec = actionRecommendations[idx];
        const updatedRec = parseToolCallToRecommendation(original_tool, {
          ...new_parameters,
          predicted_impact: new_parameters.predicted_impact ?? oldRec.predicted_impact
        });
        updatedRec.reason = new_reason || updatedRec.reason;
        updatedRec.confidence = (new_confidence as any) || updatedRec.confidence;

        actionRecommendations[idx] = updatedRec;
        const recIdx = recommendations.findIndex(r => r.entity_id === original_entity_id && r.tool === original_tool);
        if (recIdx !== -1) recommendations[recIdx] = updatedRec;

        // Update in D1
        try {
          await this.env.DB.prepare(`
            UPDATE ai_decisions SET parameters = ?, reason = ?, confidence = ?, predicted_impact = ?
            WHERE organization_id = ? AND entity_id = ? AND tool = ? AND status = 'pending'
          `).bind(
            JSON.stringify(new_parameters),
            new_reason || oldRec.reason,
            (new_confidence as string) || oldRec.confidence,
            new_parameters.predicted_impact ?? oldRec.predicted_impact ?? null,
            orgId, original_entity_id, original_tool
          ).run();
        } catch { /* D1 update is best-effort */ }

        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: {
            status: 'updated',
            message: `Recommendation for ${oldRec.entity_name} (${original_tool}) has been updated.`,
            action_recommendation_count: actionRecommendations.length,
            action_recommendations_remaining: maxActionRecommendations - actionRecommendations.length
          }
        });
        await logEvent(toolCall.name, `Updated ${original_tool} for ${oldRec.entity_name}`, 'updated', toolCall.input, { status: 'updated', old_reason: oldRec.reason, new_reason });
        continue;
      }

      // Handle delete_recommendation — withdraw a previous recommendation, freeing an action slot
      if (isDeleteRecommendationTool(toolCall.name)) {
        const { original_entity_id, original_tool, reason } = toolCall.input;

        const idx = actionRecommendations.findIndex(r => r.entity_id === original_entity_id && r.tool === original_tool);
        if (idx === -1) {
          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: { status: 'error', message: `No pending recommendation found for entity_id=${original_entity_id} tool=${original_tool}.` }
          });
          await logEvent(toolCall.name, `Delete ${original_tool} for ${original_entity_id}`, 'error', toolCall.input, { status: 'not_found' });
          continue;
        }

        const deletedRec = actionRecommendations[idx];
        actionRecommendations.splice(idx, 1);
        const recIdx = recommendations.findIndex(r => r.entity_id === original_entity_id && r.tool === original_tool);
        if (recIdx !== -1) recommendations.splice(recIdx, 1);

        // Reset max-hit flag since we freed a slot
        if (hitMaxActionRecommendations && actionRecommendations.length < maxActionRecommendations) {
          hitMaxActionRecommendations = false;
        }

        // Delete from D1
        try {
          await this.env.DB.prepare(`
            DELETE FROM ai_decisions
            WHERE organization_id = ? AND entity_id = ? AND tool = ? AND status = 'pending'
          `).bind(orgId, original_entity_id, original_tool).run();
        } catch { /* D1 delete is best-effort */ }

        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: {
            status: 'deleted',
            message: `Recommendation for ${deletedRec.entity_name} (${original_tool}) has been withdrawn. You now have ${maxActionRecommendations - actionRecommendations.length} action slots remaining.`,
            action_recommendation_count: actionRecommendations.length,
            action_recommendations_remaining: maxActionRecommendations - actionRecommendations.length
          }
        });
        await logEvent(toolCall.name, `Deleted ${original_tool} for ${deletedRec.entity_name}`, 'deleted', toolCall.input, { status: 'deleted', reason, deleted_entity: deletedRec.entity_name });
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

          // Validate spend limits before accepting the recommendation
          const spendCheck = validateSpendLimits(toolCall.name, toolCall.input, config, simResult.data);
          if (!spendCheck.valid) {
            toolResults.push({
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: {
                status: 'spend_limit_violation',
                violation: spendCheck.violation,
                message: spendCheck.details
              }
            });
            await logEvent(toolCall.name, summarizeToolInput(toolCall), 'spend_limit_violation', toolCall.input, { status: 'spend_limit_violation', violation: spendCheck.violation, details: spendCheck.details });
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

        // Validate spend limits for direct-logged tools (reallocate_budget, etc.)
        const directSpendCheck = validateSpendLimits(toolCall.name, toolCall.input, config);
        if (!directSpendCheck.valid) {
          toolResults.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: {
              status: 'spend_limit_violation',
              violation: directSpendCheck.violation,
              message: directSpendCheck.details
            }
          });
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'spend_limit_violation', toolCall.input, { status: 'spend_limit_violation', violation: directSpendCheck.violation, details: directSpendCheck.details });
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
