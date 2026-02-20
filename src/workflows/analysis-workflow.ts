/**
 * Analysis Workflow
 *
 * Cloudflare Workflow for durable AI analysis execution.
 * Migrated from waitUntil() to handle long-running analysis jobs
 * without timing out during LLM call waits.
 *
 * Step Structure:
 * 1. build_entity_tree - Fetch from D1, return serialized tree
 * 2. analyze_ads - Process all ads (2 concurrent LLM calls)
 * 3. analyze_adsets - Process all adsets with child summaries
 * 4. analyze_campaigns - Process all campaigns
 * 5. analyze_accounts - Process all accounts
 * 6. cross_platform_summary - Generate executive summary
 * 7-N. agentic_iteration_N - Variable iterations (1-200)
 * Final. complete_job - Mark job complete in D1
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import {
  AnalysisWorkflowParams,
  SerializedEntityTree,
  SerializedEntity,
  LevelAnalysisResult,
  AgenticIterationResult,
  AccumulatedInsightData,
  serializeEntityTree,
  deserializeEntityTree,
  getEntitiesAtLevel,
  createLimiter,
  isActiveStatus,
  pruneEntityTree,
  MAX_ENTITIES_PER_WORKFLOW
} from './analysis-helpers';
import { EntityTreeBuilder, Entity, EntityLevel, Platform } from '../services/analysis/entity-tree';
import { MetricsFetcher, TimeseriesMetric, DateRange } from '../services/analysis/metrics-fetcher';
import { LLMRouter, LLMRuntimeConfig } from '../services/analysis/llm-router';
import { PromptManager } from '../services/analysis/prompt-manager';
import { AnalysisLogger } from '../services/analysis/analysis-logger';
import { JobManager } from '../services/analysis/job-manager';
import { AnalysisLevel, GEMINI_MODELS } from '../services/analysis/llm-provider';
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

    // Step 1.5: Pre-filter entities with activity in the analysis window
    // This dramatically reduces entity count for large accounts (e.g. 1692 → ~200)
    // by skipping entities with zero spend/impressions upfront, avoiding per-entity D1 queries
    const filteredTree = await step.do('filter_active_entities', {
      retries: { limit: 2, delay: '5 seconds' },
      timeout: '1 minute'
    }, async () => {
      // Single batch query to find all entity IDs with any activity
      const activeResult = await this.env.ANALYTICS_DB.prepare(`
        SELECT entity_ref, SUM(spend_cents) as total_spend
        FROM ad_metrics
        WHERE organization_id = ?
          AND metric_date >= ?
          AND metric_date <= ?
          AND (spend_cents > 0 OR impressions > 0)
        GROUP BY entity_ref
        ORDER BY total_spend DESC
        LIMIT ?
      `).bind(orgId, dateRange.start, dateRange.end, MAX_ENTITIES_PER_WORKFLOW).all<{
        entity_ref: string;
        total_spend: number;
      }>();

      const activeEntityIds = new Set((activeResult.results || []).map(r => r.entity_ref));

      if (activeEntityIds.size === 0) {
        console.log(`[Analysis] No entities with activity in ${days}-day window, processing full tree`);
        return entityTree;
      }

      const pruned = pruneEntityTree(entityTree, activeEntityIds);
      console.log(`[Analysis] Pre-filtered: ${entityTree.totalEntities} → ${pruned.totalEntities} entities (${activeEntityIds.size} with activity)`);

      // Update job total to reflect pruned count
      const jobs = new JobManager(this.env.DB);
      await jobs.startJob(jobId, pruned.totalEntities + 2);

      return pruned;
    });

    // Use filtered tree for all subsequent processing
    const activeTree = filteredTree;

    // Log entity tree structure so dashboard can build the tree visualization
    try {
      const treeSummary = buildTreeSummaryForEvents(activeTree);
      await this.env.DB.prepare(
        `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'entity_tree', NULL, ?, NULL)`
      ).bind(jobId, orgId, treeSummary).run();
    } catch (e) { /* non-critical */ }

    // Storage for summaries - passed between steps as JSON
    let summariesByEntity: Record<string, string> = {};
    let processedCount = 0;

    // Steps 2-5: Process each level in batches
    // With pre-filtering, most inactive entities are already removed
    const BATCH_SIZE = 15;
    const levels: AnalysisLevel[] = ['ad', 'adset', 'campaign', 'account'];

    for (const level of levels) {
      const entities = getEntitiesAtLevel(activeTree, level as EntityLevel);
      const totalBatches = Math.ceil(entities.length / BATCH_SIZE);

      // Log phase change event
      try {
        await this.env.DB.prepare(
          `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'phase_change', NULL, ?, NULL)`
        ).bind(jobId, orgId, `Analyzing ${entities.length} ${level}s`).run();
      } catch (e) { /* non-critical */ }

      // Process entities in batches
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const batchStart = batchIndex * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, entities.length);
        const batchEntities = entities.slice(batchStart, batchEnd);

        const result = await step.do(`analyze_${level}s_batch_${batchIndex + 1}`, {
          retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
          timeout: '10 minutes'
        }, async () => {
          return await this.analyzeLevelBatch(
            orgId,
            level as EntityLevel,
            batchEntities,
            summariesByEntity,
            dateRange,
            runId,
            days,
            jobId,
            processedCount,
            config?.llm,
            activeTree
          );
        });

        // Merge new summaries
        summariesByEntity = { ...summariesByEntity, ...result.summaries };
        processedCount = result.processedCount;
      }
    }

    // Log phase change for cross-platform summary
    try {
      await this.env.DB.prepare(
        `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'phase_change', NULL, ?, NULL)`
      ).bind(jobId, orgId, 'Generating cross-platform summary').run();
    } catch (e) { /* non-critical */ }

    // Step 6: Cross-platform summary
    const crossPlatformResult = await step.do('cross_platform_summary', {
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '5 minutes'
    }, async () => {
      return await this.generateCrossPlatformSummary(
        orgId,
        activeTree,
        summariesByEntity,
        dateRange,
        runId,
        days,
        jobId,
        processedCount,
        config?.llm
      );
    });

    const { crossPlatformSummary, platformSummaries, additionalContext } = crossPlatformResult;
    processedCount = crossPlatformResult.processedCount;

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
        systemPrompt: this.buildAgenticSystemPrompt(days, customInstructions, recentRecs)
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
    while (iterations < maxIterations && actionRecommendations.length < maxActionRecommendations) {
      iterations++;

      const iterResult = await step.do(`agentic_iteration_${iterations}`, {
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
        timeout: '5 minutes'
      }, async () => {
        return await this.runAgenticIteration(
          orgId,
          runId,
          jobId,
          iterations,
          agenticMessages,
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

      // Merge accumulated insight state
      if (iterResult.accumulatedInsightId) {
        accumulatedInsightId = iterResult.accumulatedInsightId;
        hasInsight = true;
      }
      if (iterResult.accumulatedInsights) {
        accumulatedInsights = iterResult.accumulatedInsights;
      }

      if (iterResult.shouldStop) {
        stoppedReason = iterResult.stopReason || 'no_tool_calls';
        terminationReason = iterResult.terminationReason;
        break;
      }
    }

    // Get final summary if we stopped due to max recommendations
    let finalSummary = crossPlatformSummary;
    if (stoppedReason === 'max_recommendations') {
      const finalResult = await step.do('agentic_final_summary', {
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
      finalSummary = finalResult || crossPlatformSummary;
    }

    // Increment for recommendations step
    processedCount++;

    // Final step: Complete the job
    await step.do('complete_job', {
      retries: { limit: 3, delay: '1 second' },
      timeout: '30 seconds'
    }, async () => {
      const jobs = new JobManager(this.env.DB);
      await jobs.updateProgress(jobId, processedCount, 'recommendations');
      await jobs.completeJob(jobId, runId, stoppedReason, terminationReason);
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
  }


  /**
   * Analyze all entities at a specific level
   */
  /**
   * Analyze a batch of entities at a specific level
   * Split from analyzeLevel to avoid 1000 subrequest limit
   */
  private async analyzeLevelBatch(
    orgId: string,
    level: EntityLevel,
    entities: SerializedEntity[],
    existingSummaries: Record<string, string>,
    dateRange: DateRange,
    runId: string,
    days: number,
    jobId: string,
    startingCount: number,
    llmConfig?: LLMRuntimeConfig,
    entityTree?: SerializedEntityTree
  ): Promise<LevelAnalysisResult> {
    // Use D1 ANALYTICS_DB for metrics
    const metrics = new MetricsFetcher(this.env.ANALYTICS_DB);
    const anthropicKey = await getSecret(this.env.ANTHROPIC_API_KEY);
    const geminiKey = await getSecret(this.env.GEMINI_API_KEY);
    const llm = new LLMRouter({
      anthropicApiKey: anthropicKey!,
      geminiApiKey: geminiKey!
    });
    const prompts = new PromptManager(this.env.DB);
    const logger = new AnalysisLogger(this.env.DB);
    const jobs = new JobManager(this.env.DB);

    const limiter = createLimiter(1); // Max 1 concurrent LLM call to stay under subrequest limit

    const summaries: Record<string, string> = {};
    let processedCount = startingCount;

    // Process batch entities sequentially to minimize concurrent subrequests
    // NOTE: Job progress is updated once at end of batch, not per entity (saves D1 calls)
    let llmCallCount = 0;
    let skippedCount = 0;

    for (const entity of entities) {
      // Note: Hierarchy skip moved INSIDE analyzeEntity so we can check activity first
      // If parent is disabled BUT entity had recent spend, we still want to analyze it

      const summary = await this.analyzeEntity(
        orgId,
        entity,
        level as AnalysisLevel,
        dateRange,
        existingSummaries,
        runId,
        days,
        metrics,
        llm,
        prompts,
        logger,
        llmConfig,
        true  // skipLogging - skip per-entity logging to reduce D1 calls
      );

      // Track if this was an LLM call or a skip (status-only summaries start with "Status:")
      if (summary.startsWith('Status:')) {
        skippedCount++;
      } else {
        llmCallCount++;
      }

      summaries[entity.id] = summary;
      processedCount++;

      // Log entity completion for tree visualization
      try {
        await this.env.DB.prepare(
          `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, 0, 'entity_complete', NULL, ?, ?)`
        ).bind(jobId, orgId, `${entity.name}`, `${entity.platform}:${level}`).run();
      } catch (e) { /* non-critical */ }
    }

    // Log batch efficiency
    console.log(`[Analysis] ${level} batch: ${llmCallCount} LLM calls, ${skippedCount} skipped (inactive/no data)`);

    // Single D1 update at end of batch (instead of per-entity)
    await jobs.updateProgress(jobId, processedCount, level as AnalysisLevel);

    return { summaries, processedCount };
  }

  /**
   * Analyze a single entity
   * @param skipLogging - if true, skip per-entity logging to reduce D1 calls
   */
  private async analyzeEntity(
    orgId: string,
    entity: SerializedEntity,
    level: AnalysisLevel,
    dateRange: DateRange,
    summariesByEntity: Record<string, string>,
    runId: string,
    days: number,
    metrics: MetricsFetcher,
    llm: LLMRouter,
    prompts: PromptManager,
    logger: AnalysisLogger,
    llmConfig?: LLMRuntimeConfig,
    skipLogging: boolean = false
  ): Promise<string> {
    // Get metrics for this entity
    let entityMetrics: TimeseriesMetric[];
    if (entity.children.length > 0) {
      const childIds = entity.children.map(c => c.id);
      entityMetrics = await metrics.fetchAggregatedMetrics(
        entity.platform,
        entity.level,
        childIds,
        dateRange
      );
    } else {
      entityMetrics = await metrics.fetchMetrics(
        entity.platform,
        entity.level,
        entity.id,
        dateRange
      );
    }

    // === SKIP LLM only if NO activity in the analysis window ===
    // Key insight: If entity had spend in last 7 days, analyze it even if now paused
    // This helps understand recent performance before the pause
    const hasActivity = entityMetrics.length > 0 && entityMetrics.some(m =>
      (m.spend_cents && m.spend_cents > 0) ||
      (m.impressions && m.impressions > 0)
    );
    const isActive = isActiveStatus(entity.status);

    // Only skip if there's NO activity to analyze
    // If paused but had recent spend → still analyze to understand performance
    if (!hasActivity) {
      const statusInfo = isActive
        ? `Status: ${entity.status} (no activity in ${days}-day window)`
        : `Status: ${entity.status}`;

      // For parent entities, still include child summary rollup
      if (entity.children.length > 0) {
        const activeChildren = entity.children.filter(c =>
          isActiveStatus(c.status)
        ).length;
        const totalChildren = entity.children.length;
        const childType = entity.level === 'campaign' ? 'ad sets' : entity.level === 'adset' ? 'ads' : 'children';
        return `${statusInfo}. Contains ${activeChildren}/${totalChildren} active ${childType}.`;
      }

      return statusInfo;
    }
    // === END SKIP LLM ===

    // If we get here, entity has activity - analyze with LLM even if currently paused

    // Get child summaries for non-leaf levels
    const childSummaries = entity.children.map(child => ({
      name: child.name,
      summary: summariesByEntity[child.id] || 'No summary available',
      platform: child.platform
    }));

    // Get prompt template
    const template = await prompts.getTemplateForLevel(level, entity.platform);
    if (!template) {
      return `Analysis unavailable: No template for ${level}`;
    }

    // Build variables for hydration
    const variables: Record<string, string> = {
      days: String(days),
      platform: entity.platform,
      metrics_table: prompts.formatMetricsTable(entityMetrics),
      child_summaries: prompts.formatChildSummaries(childSummaries)
    };

    // Add level-specific name variable
    if (level === 'ad') variables.ad_name = entity.name;
    if (level === 'adset') variables.adset_name = entity.name;
    if (level === 'campaign') variables.campaign_name = entity.name;
    if (level === 'account') variables.account_name = entity.name;

    // Hydrate template
    const userPrompt = prompts.hydrateTemplate(template, variables);
    const systemPrompt = 'You are an expert digital advertising analyst. Be concise and actionable.';

    // Generate summary
    const response = await llm.generateSummaryForLevel(
      level,
      systemPrompt,
      userPrompt,
      undefined,
      llmConfig
    );

    // Log the call (skip in batch mode to reduce D1 calls)
    if (!skipLogging) {
      await logger.logCall({
        orgId,
        level,
        platform: entity.platform,
        entityId: entity.id,
        entityName: entity.name,
        provider: response.provider,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs: response.latencyMs,
        prompt: userPrompt,
        response: response.content,
        analysisRunId: runId
      });

      // Save summary (skip in batch mode to reduce D1 calls - summaries stored in workflow state)
      await this.saveSummary(
        orgId,
        runId,
        level,
        entity.platform,
        entity.id,
        entity.name,
        response.content,
        entityMetrics,
        days
      );
    }

    return response.content;
  }

  /**
   * Generate cross-platform executive summary
   */
  private async generateCrossPlatformSummary(
    orgId: string,
    entityTree: SerializedEntityTree,
    summariesByEntity: Record<string, string>,
    dateRange: DateRange,
    runId: string,
    days: number,
    jobId: string,
    startingCount: number,
    llmConfig?: LLMRuntimeConfig
  ): Promise<{ crossPlatformSummary: string; platformSummaries: Record<string, string>; processedCount: number; additionalContext?: string }> {
    // Use D1 ANALYTICS_DB for metrics
    const metrics = new MetricsFetcher(this.env.ANALYTICS_DB);
    const anthropicKey = await getSecret(this.env.ANTHROPIC_API_KEY);
    const geminiKey = await getSecret(this.env.GEMINI_API_KEY);
    const llm = new LLMRouter({
      anthropicApiKey: anthropicKey!,
      geminiApiKey: geminiKey!
    });
    const prompts = new PromptManager(this.env.DB);
    const logger = new AnalysisLogger(this.env.DB);
    const jobs = new JobManager(this.env.DB);

    // Build platform summaries from account summaries
    const platformSummaries: Record<string, string> = {};
    for (const [key, account] of entityTree.accounts) {
      const platform = account.platform;
      const accountSummary = summariesByEntity[account.id] || '';
      platformSummaries[platform] = platformSummaries[platform]
        ? platformSummaries[platform] + '\n\n' + accountSummary
        : accountSummary;
    }

    // Calculate totals + per-platform breakdowns (deterministic math)
    let totalSpendCents = 0;
    let totalRevenueCents = 0;
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalConversions = 0;
    const platformMetrics: Record<string, { spend_cents: number; revenue_cents: number; impressions: number; clicks: number; conversions: number }> = {};

    // Deserialize to get proper Map iteration
    const tree = deserializeEntityTree(entityTree);
    for (const account of tree.accounts.values()) {
      const childIds = account.children.map(c => c.id);
      const accountMetrics = await metrics.fetchAggregatedMetrics(
        account.platform,
        'account',
        childIds,
        dateRange
      );
      const totals = metrics.sumMetrics(accountMetrics);
      totalSpendCents += totals.spend_cents;
      totalRevenueCents += totals.conversion_value_cents;
      totalImpressions += totals.impressions;
      totalClicks += totals.clicks;
      totalConversions += totals.conversions;

      const p = account.platform;
      if (!platformMetrics[p]) {
        platformMetrics[p] = { spend_cents: 0, revenue_cents: 0, impressions: 0, clicks: 0, conversions: 0 };
      }
      platformMetrics[p].spend_cents += totals.spend_cents;
      platformMetrics[p].revenue_cents += totals.conversion_value_cents;
      platformMetrics[p].impressions += totals.impressions;
      platformMetrics[p].clicks += totals.clicks;
      platformMetrics[p].conversions += totals.conversions;
    }

    const totalSpend = `$${(totalSpendCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const blendedRoas = totalSpendCents > 0
      ? (totalRevenueCents / totalSpendCents).toFixed(2)
      : '0.00';

    // Build deterministic computed metrics snapshot (no LLM needed for these numbers)
    const fmt = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (num: number, den: number) => den > 0 ? (num / den * 100).toFixed(1) + '%' : 'N/A';

    let computedSnapshot = `## Computed Metrics (${days}d, deterministic)\n`;
    computedSnapshot += `| Metric | Value |\n|---|---|\n`;
    computedSnapshot += `| Total Spend | ${fmt(totalSpendCents)} |\n`;
    computedSnapshot += `| Total Revenue (platform-reported) | ${fmt(totalRevenueCents)} |\n`;
    computedSnapshot += `| Blended ROAS | ${blendedRoas}x |\n`;
    computedSnapshot += `| Total Impressions | ${totalImpressions.toLocaleString()} |\n`;
    computedSnapshot += `| Total Clicks | ${totalClicks.toLocaleString()} |\n`;
    computedSnapshot += `| Blended CTR | ${pct(totalClicks, totalImpressions)} |\n`;
    computedSnapshot += `| Total Conversions | ${totalConversions.toLocaleString()} |\n`;
    computedSnapshot += `| Blended CPA | ${totalConversions > 0 ? fmt(Math.round(totalSpendCents / totalConversions)) : 'N/A'} |\n`;
    computedSnapshot += `| Blended CPC | ${totalClicks > 0 ? fmt(Math.round(totalSpendCents / totalClicks)) : 'N/A'} |\n`;
    computedSnapshot += `| Conv. Rate (click→conv) | ${pct(totalConversions, totalClicks)} |\n\n`;

    // Per-platform breakdown
    const platformNames = Object.keys(platformMetrics);
    if (platformNames.length > 1) {
      computedSnapshot += `### Per-Platform Breakdown\n`;
      computedSnapshot += `| Platform | Spend | Revenue | ROAS | CPA | CTR | Conversions |\n|---|---|---|---|---|---|---|\n`;
      for (const p of platformNames) {
        const m = platformMetrics[p];
        const pRoas = m.spend_cents > 0 ? (m.revenue_cents / m.spend_cents).toFixed(2) + 'x' : 'N/A';
        const pCpa = m.conversions > 0 ? fmt(Math.round(m.spend_cents / m.conversions)) : 'N/A';
        const pCtr = pct(m.clicks, m.impressions);
        computedSnapshot += `| ${p.charAt(0).toUpperCase() + p.slice(1)} | ${fmt(m.spend_cents)} | ${fmt(m.revenue_cents)} | ${pRoas} | ${pCpa} | ${pCtr} | ${m.conversions.toLocaleString()} |\n`;
      }
      computedSnapshot += '\n';

      // Spend share
      computedSnapshot += `### Spend Allocation\n`;
      for (const p of platformNames) {
        const share = totalSpendCents > 0 ? (platformMetrics[p].spend_cents / totalSpendCents * 100).toFixed(1) : '0';
        computedSnapshot += `- ${p.charAt(0).toUpperCase() + p.slice(1)}: ${share}%\n`;
      }
      computedSnapshot += '\n';
    }

    // Fetch additional context: journey analytics, traffic, CAC trend
    let additionalContext = computedSnapshot;
    try {
      // Resolve org_tag
      const orgTagRow = await this.env.DB.prepare(
        'SELECT org_tag FROM org_tag_mappings WHERE organization_id = ? LIMIT 1'
      ).bind(orgId).first<{ org_tag: string }>();
      const orgTag = orgTagRow?.org_tag;

      // Journey analytics
      if (orgTag) {
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

        // Daily traffic summary
        try {
          const traffic = await this.env.ANALYTICS_DB.prepare(`
            SELECT SUM(sessions) as sessions, SUM(unique_users) as users,
                   SUM(conversions) as conversions, SUM(revenue_cents) as revenue_cents
            FROM daily_metrics
            WHERE org_tag = ?
              AND metric_date >= date('now', '-${days} days')
          `).bind(orgTag).first<{
            sessions: number | null;
            users: number | null;
            conversions: number | null;
            revenue_cents: number | null;
          }>();

          if (traffic && (traffic.sessions || 0) > 0) {
            const tSessions = traffic.sessions || 0;
            const tConversions = traffic.conversions || 0;
            const tRevenue = traffic.revenue_cents || 0;
            additionalContext += `## Site Traffic (${days}d)\n`;
            additionalContext += `- Sessions: ${tSessions.toLocaleString()}\n`;
            additionalContext += `- Unique users: ${(traffic.users || 0).toLocaleString()}\n`;
            additionalContext += `- Conversions: ${tConversions.toLocaleString()}\n`;
            additionalContext += `- Revenue: ${fmt(tRevenue)}\n`;
            additionalContext += `- Site conv. rate: ${pct(tConversions, tSessions)}\n`;
            if (totalSpendCents > 0 && tSessions > 0) {
              additionalContext += `- Cost per session: ${fmt(Math.round(totalSpendCents / tSessions))}\n`;
            }
            additionalContext += '\n';
          }
        } catch { /* daily_metrics may not exist */ }
      }

      // CAC trend from ANALYTICS_DB
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
          const trendPct = oldest > 0
            ? Math.round(((current - oldest) / oldest) * 100)
            : 0;
          const values = cacHistory.map(h => h.cac_cents);
          const minCac = Math.min(...values);
          const maxCac = Math.max(...values);

          additionalContext += `## CAC Trend (14d)\n`;
          additionalContext += `- Current CAC: ${fmt(current)}\n`;
          additionalContext += `- Trend: ${trendPct > 0 ? '+' : ''}${trendPct}% over ${cacHistory.length} days\n`;
          additionalContext += `- Range: ${fmt(minCac)} – ${fmt(maxCac)}\n`;
          // Cross-reference: CAC vs blended CPA from ad platforms
          if (totalConversions > 0) {
            const platformCpa = Math.round(totalSpendCents / totalConversions);
            const delta = current > 0 ? Math.round(((platformCpa - current) / current) * 100) : 0;
            additionalContext += `- Platform CPA vs tracked CAC: ${fmt(platformCpa)} vs ${fmt(current)} (${delta > 0 ? '+' : ''}${delta}%)\n`;
          }
          additionalContext += '\n';
        }
      } catch { /* cac_history may not exist */ }

      // Shopify revenue (from connector_events)
      try {
        const shopify = await this.env.ANALYTICS_DB.prepare(`
          SELECT COUNT(*) as orders, COALESCE(SUM(value_cents), 0) as revenue_cents,
                 AVG(value_cents) as aov_cents,
                 COUNT(DISTINCT customer_external_id) as unique_customers
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform = 'shopify'
            AND transacted_at >= date('now', '-${days} days')
            AND platform_status IN ('succeeded', 'paid', 'completed', 'active')
        `).bind(orgId).first<{
          orders: number; revenue_cents: number | null; aov_cents: number | null; unique_customers: number;
        }>();

        if (shopify && (shopify.orders || 0) > 0) {
          additionalContext += `## Shopify Revenue (${days}d)\n`;
          additionalContext += `- Orders: ${shopify.orders.toLocaleString()}\n`;
          additionalContext += `- Revenue: ${fmt(shopify.revenue_cents || 0)}\n`;
          additionalContext += `- AOV: ${fmt(Math.round(shopify.aov_cents || 0))}\n`;
          additionalContext += `- Unique customers: ${shopify.unique_customers}\n`;
          if (totalSpendCents > 0 && shopify.revenue_cents) {
            additionalContext += `- Shopify ROAS (vs ad spend): ${(shopify.revenue_cents / totalSpendCents).toFixed(2)}x\n`;
          }
          additionalContext += '\n';
        }
      } catch { /* connector_events query failed */ }

      // CRM pipeline (from connector_events — HubSpot deal events)
      try {
        const crm = await this.env.ANALYTICS_DB.prepare(`
          SELECT COUNT(*) as deals,
                 COUNT(CASE WHEN platform_status = 'closedwon' THEN 1 END) as won,
                 COUNT(CASE WHEN platform_status = 'closedlost' THEN 1 END) as lost,
                 COUNT(CASE WHEN platform_status NOT IN ('closedwon', 'closedlost') THEN 1 END) as open_deals,
                 SUM(value_cents) as pipeline_cents,
                 SUM(CASE WHEN platform_status = 'closedwon' THEN value_cents ELSE 0 END) as won_cents
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform = 'hubspot' AND event_type = 'deal'
            AND transacted_at >= date('now', '-${days} days')
        `).bind(orgId).first<{
          deals: number; won: number; lost: number; open_deals: number;
          pipeline_cents: number | null; won_cents: number | null;
        }>();

        if (crm && (crm.deals || 0) > 0) {
          additionalContext += `## CRM Pipeline (${days}d)\n`;
          additionalContext += `- Total deals: ${crm.deals} (${crm.open_deals} open, ${crm.won} won, ${crm.lost} lost)\n`;
          additionalContext += `- Pipeline value: ${fmt(crm.pipeline_cents || 0)}\n`;
          additionalContext += `- Won value: ${fmt(crm.won_cents || 0)}\n`;
          const winRate = (crm.won + crm.lost) > 0 ? Math.round(crm.won / (crm.won + crm.lost) * 100) : 0;
          additionalContext += `- Win rate: ${winRate}%\n`;
          if (totalSpendCents > 0 && crm.won_cents) {
            additionalContext += `- CRM ROAS (won value vs ad spend): ${(crm.won_cents / totalSpendCents).toFixed(2)}x\n`;
          }
          additionalContext += '\n';
        }
      } catch { /* connector_events deal query failed */ }

      // Subscription activity (from connector_events — Stripe subscription events)
      try {
        const subs = await this.env.ANALYTICS_DB.prepare(`
          SELECT COUNT(*) as total,
                 COUNT(CASE WHEN platform_status IN ('active', 'trialing') THEN 1 END) as active,
                 COUNT(CASE WHEN platform_status IN ('canceled', 'cancelled') THEN 1 END) as canceled,
                 COALESCE(SUM(CASE WHEN platform_status IN ('active', 'trialing') THEN value_cents ELSE 0 END), 0) as mrr_cents
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

      // Email/SMS engagement (from connector_events)
      try {
        const comms = await this.env.ANALYTICS_DB.prepare(`
          SELECT event_type, COUNT(*) as count
          FROM connector_events
          WHERE organization_id = ?
            AND source_platform IN ('sendgrid', 'attentive', 'mailchimp', 'tracking_link')
            AND transacted_at >= date('now', '-${days} days')
          GROUP BY event_type
        `).bind(orgId).all<{ event_type: string; count: number }>();

        const engMap: Record<string, number> = {};
        for (const r of comms.results || []) {
          engMap[r.event_type] = r.count;
        }

        const sent = (engMap['email_sent'] || 0) + (engMap['sms_sent'] || 0);
        const opens = engMap['email_open'] || 0;
        const clicks = (engMap['email_click'] || 0) + (engMap['sms_click'] || 0) + (engMap['link_click'] || 0);
        const totalEvents = Object.values(engMap).reduce((a, b) => a + b, 0);

        if (totalEvents > 0) {
          additionalContext += `## Email/SMS (${days}d)\n`;
          additionalContext += `- Sent: ${sent.toLocaleString()}\n`;
          additionalContext += `- Opens: ${opens.toLocaleString()} (${sent > 0 ? (opens / sent * 100).toFixed(1) : '0'}%)\n`;
          additionalContext += `- Clicks: ${clicks.toLocaleString()} (${sent > 0 ? (clicks / sent * 100).toFixed(1) : '0'}%)\n\n`;
        }
      } catch { /* connector_events comm query failed */ }

    } catch {
      // Non-critical — additional context is best-effort
    }

    // Format platform summaries for prompt
    const childSummaries = Object.entries(platformSummaries).map(([platform, summary]) => ({
      name: platform.charAt(0).toUpperCase() + platform.slice(1),
      summary,
      platform
    }));

    // Get template
    const template = await prompts.getTemplateForLevel('cross_platform');
    if (!template) {
      return {
        crossPlatformSummary: 'Cross-platform analysis unavailable: No template configured',
        platformSummaries,
        processedCount: startingCount + 1
      };
    }

    // Hydrate
    const variables: Record<string, string> = {
      days: String(days),
      org_name: `Organization ${orgId.substring(0, 8)}`,
      total_spend: totalSpend,
      blended_roas: blendedRoas,
      child_summaries: prompts.formatChildSummaries(childSummaries)
    };

    const userPrompt = prompts.hydrateTemplate(template, variables);
    const systemPrompt = 'You are a strategic marketing advisor. Provide executive-level insights.';

    // Generate with configured model
    const response = await llm.generateSummaryForLevel(
      'cross_platform',
      systemPrompt,
      userPrompt,
      undefined,
      llmConfig
    );

    // Log
    await logger.logCall({
      orgId,
      level: 'cross_platform',
      entityId: 'cross_platform',
      entityName: 'Cross-Platform Summary',
      provider: response.provider,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      latencyMs: response.latencyMs,
      prompt: userPrompt,
      response: response.content,
      analysisRunId: runId
    });

    // Save
    await this.saveSummary(
      orgId,
      runId,
      'cross_platform',
      null,
      'cross_platform',
      'Cross-Platform Summary',
      response.content,
      [],
      days
    );

    const processedCount = startingCount + 1;
    await jobs.updateProgress(jobId, processedCount, 'cross_platform');

    return {
      crossPlatformSummary: response.content,
      platformSummaries,
      processedCount,
      additionalContext: additionalContext || undefined
    };
  }

  /**
   * Save an analysis summary
   */
  private async saveSummary(
    orgId: string,
    runId: string,
    level: AnalysisLevel,
    platform: string | null,
    entityId: string,
    entityName: string,
    summary: string,
    metrics: TimeseriesMetric[],
    days: number
  ): Promise<void> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    await this.env.DB.prepare(`
      INSERT INTO analysis_summaries (
        id, organization_id, level, platform, entity_id, entity_name,
        summary, metrics_snapshot, days, analysis_run_id, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      orgId,
      level,
      platform ?? null,
      entityId ?? null,
      entityName ?? null,
      summary ?? null,
      JSON.stringify(metrics ?? {}),
      days ?? 7,
      runId ?? null,
      expiresAt.toISOString()
    ).run();
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
    recentRecs: Array<{ action: string; parameters: string; reason: string; status: string; days_ago: number }>
  ): string {
    let systemPrompt = `You are an expert digital advertising strategist. Based on the analysis provided, identify actionable optimizations.

IMPORTANT DATE RANGE: This analysis covers the LAST ${days} DAYS only.

IMPORTANT DATA UNITS: All monetary values in raw data are in CENTS (not dollars).

CRITICAL - BUDGET vs SPEND:
- BUDGET is the configured limit
- SPEND is what was actually spent
- ALWAYS use get_entity_budget to check actual budget before recommending changes.

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

    // Call LLM via provider-agnostic client
    const callResult = await client.call(messages, systemPrompt, tools);

    // If no tool calls, we're done
    if (callResult.toolCalls.length === 0) {
      return {
        messages,
        recommendations: existingRecommendations,
        shouldStop: true,
        stopReason: 'no_tool_calls',
        accumulatedInsightId: accumulatedInsightId || undefined,
        accumulatedInsights
      };
    }

    // Add assistant response (provider-specific format preserved)
    const updatedMessages = [...messages, client.buildAssistantMessage(callResult.rawAssistantMessage)];

    // Process tool calls
    const toolResults: AgenticToolResult[] = [];
    const recommendations = [...existingRecommendations];
    let hitMaxActionRecommendations = false;

    // Helper to log tool call events to analysis_events table (fire-and-forget, non-blocking)
    const logEvent = async (toolName: string, summary: string, status: string) => {
      try {
        await this.env.DB.prepare(
          `INSERT INTO analysis_events (job_id, organization_id, iteration, event_type, tool_name, tool_input_summary, tool_status) VALUES (?, ?, ?, 'tool_call', ?, ?, ?)`
        ).bind(jobId, orgId, iteration, toolName, summary, status).run();
      } catch (e) {
        // Non-critical — don't fail the iteration if event logging fails
        console.error('[Analysis] Failed to log event:', e);
      }
    };

    for (const toolCall of callResult.toolCalls) {
      // Handle terminate_analysis (control tool - NOT logged to DB)
      if (isTerminateAnalysisTool(toolCall.name)) {
        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: { status: 'terminating', message: 'Analysis terminated by AI decision' }
        });

        await logEvent(toolCall.name, summarizeToolInput(toolCall), 'terminating');

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
          accumulatedInsights
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
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'appended');
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
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'created');
        }
        continue;
      }

      // Handle exploration tools
      if (isExplorationTool(toolCall.name)) {
        const exploreResult = await explorationExecutor.execute(toolCall.name, toolCall.input, orgId);
        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: exploreResult
        });
        await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged');
        continue;
      }

      // Handle live API queries
      if (toolCall.name === 'query_api') {
        const liveApi = new LiveApiExecutor(this.env.DB, this.env);
        const liveResult = await liveApi.execute(toolCall.input as any, orgId);
        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: liveResult
        });
        await logEvent(toolCall.name, summarizeToolInput(toolCall), liveResult.success ? 'logged' : 'error');
        continue;
      }

      // Handle simulate_change tool - this runs BEFORE recommendations
      // The simulation cache is shared across iterations so LLM must acknowledge results
      if (toolCall.name === 'simulate_change') {
        const simContext: ToolExecutionContext = {
          orgId,
          analysisRunId: runId,
          analyticsDb: this.env.ANALYTICS_DB,
          aiDb: this.env.DB,
          simulationCache
        };

        const simResult = await executeSimulateChange(toolCall.input as any, simContext);

        toolResults.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: {
            success: simResult.success,
            message: simResult.message,
            data: simResult.data
          }
        });
        await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged');
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
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'skipped');
          continue;
        }

        // For set_status and set_budget, use simulation-required enforcement
        // This FORCES the LLM to run simulate_change first, or the recommendation fails
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
            // Simulation was required but not done - return error with simulation data
            // The LLM must review the simulation and call the tool again
            toolResults.push({
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: {
                status: 'simulation_required',
                error: simResult.error,
                message: simResult.message,
                recommendation: simResult.recommendation  // PROCEED, RECONSIDER, or TRADEOFF
              }
            });
            await logEvent(toolCall.name, summarizeToolInput(toolCall), 'simulation_required');
            continue;
          }

          // Simulation was done, recommendation created with CALCULATED impact
          const rec = parseToolCallToRecommendation(toolCall.name, {
            ...toolCall.input,
            // Override with calculated impact from simulation
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
          await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged');

          if (actionRecommendations.length >= maxActionRecommendations) {
            hitMaxActionRecommendations = true;
          }
          continue;
        }

        // For other tools (set_audience, reallocate_budget), use direct logging
        const rec = parseToolCallToRecommendation(toolCall.name, toolCall.input);
        recommendations.push(rec);
        actionRecommendations.push(rec);  // Track action recs separately

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
        await logEvent(toolCall.name, summarizeToolInput(toolCall), 'logged');

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
      accumulatedInsights
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
  ): Promise<string | null> {
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
      return callResult.textBlocks.join('\n') || null;
    } catch {
      return null;
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
