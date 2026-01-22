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
  createLimiter
} from './analysis-helpers';
import { EntityTreeBuilder, Entity, EntityLevel, Platform } from '../services/analysis/entity-tree';
import { MetricsFetcher, TimeseriesMetric, DateRange } from '../services/analysis/metrics-fetcher';
import { LLMRouter, LLMRuntimeConfig } from '../services/analysis/llm-router';
import { PromptManager } from '../services/analysis/prompt-manager';
import { AnalysisLogger } from '../services/analysis/analysis-logger';
import { JobManager } from '../services/analysis/job-manager';
import { AnalysisLevel, CLAUDE_MODELS } from '../services/analysis/llm-provider';
import {
  getAnthropicTools,
  isRecommendationTool,
  isTerminateAnalysisTool,
  isGeneralInsightTool,
  parseToolCallToRecommendation,
  Recommendation,
  AccumulatedInsight
} from '../services/analysis/recommendation-tools';
import {
  getExplorationTools,
  isExplorationTool,
  ExplorationToolExecutor
} from '../services/analysis/exploration-tools';
import { getSecret } from '../utils/secrets';

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

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {
  /**
   * Main workflow execution
   */
  async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep): Promise<AnalysisWorkflowResult> {
    const { orgId, days, jobId, customInstructions, config } = event.payload;
    const runId = crypto.randomUUID().replace(/-/g, '');

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
      const jobs = new JobManager(this.env.AI_DB);
      await jobs.startJob(jobId, tree.totalEntities + 2);

      return serializeEntityTree(tree);
    });

    // Storage for summaries - passed between steps as JSON
    let summariesByEntity: Record<string, string> = {};
    let processedCount = 0;

    // Steps 2-5: Process each level
    const levels: AnalysisLevel[] = ['ad', 'adset', 'campaign', 'account'];

    for (const level of levels) {
      const result = await step.do(`analyze_${level}s`, {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        timeout: '15 minutes'
      }, async () => {
        return await this.analyzeLevel(
          orgId,
          level as EntityLevel,
          entityTree,
          summariesByEntity,
          dateRange,
          runId,
          days,
          jobId,
          processedCount,
          config?.llm
        );
      });

      // Merge new summaries
      summariesByEntity = { ...summariesByEntity, ...result.summaries };
      processedCount = result.processedCount;
    }

    // Step 6: Cross-platform summary
    const crossPlatformResult = await step.do('cross_platform_summary', {
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '5 minutes'
    }, async () => {
      return await this.generateCrossPlatformSummary(
        orgId,
        entityTree,
        summariesByEntity,
        dateRange,
        runId,
        days,
        jobId,
        processedCount,
        config?.llm
      );
    });

    const { crossPlatformSummary, platformSummaries } = crossPlatformResult;
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

    // Initialize agentic loop context
    const agenticContext = await step.do('agentic_init', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      timeout: '2 minutes'
    }, async () => {
      const jobs = new JobManager(this.env.AI_DB);
      await jobs.updateProgress(jobId, processedCount, 'recommendations');

      // Fetch recent recommendation history
      const recentRecs = await this.getRecentRecommendations(orgId);

      // Build initial messages
      const contextPrompt = this.buildAgenticContextPrompt(crossPlatformSummary, platformSummaries);

      return {
        recentRecs,
        contextPrompt,
        systemPrompt: this.buildAgenticSystemPrompt(days, customInstructions, recentRecs)
      };
    });

    agenticMessages = [{ role: 'user', content: agenticContext.contextPrompt }];

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
          agenticMessages,
          agenticContext.systemPrompt,
          recommendations,
          actionRecommendations,
          maxActionRecommendations,
          enableExploration,
          accumulatedInsightId,
          accumulatedInsights,
          hasInsight
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
          agenticContext.systemPrompt + `\n\nYou have made ${maxRecommendations} recommendations which is the maximum. Provide a brief final summary.`,
          enableExploration
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
      const jobs = new JobManager(this.env.AI_DB);
      await jobs.updateProgress(jobId, processedCount, 'recommendations');
      await jobs.completeJob(jobId, runId, stoppedReason, terminationReason);
    });

    return {
      runId,
      crossPlatformSummary: finalSummary,
      platformSummaries,
      entityCount: entityTree.totalEntities,
      recommendations,
      agenticIterations: iterations,
      stoppedReason,
      terminationReason
    };
  }


  /**
   * Analyze all entities at a specific level
   */
  private async analyzeLevel(
    orgId: string,
    level: EntityLevel,
    entityTree: SerializedEntityTree,
    existingSummaries: Record<string, string>,
    dateRange: DateRange,
    runId: string,
    days: number,
    jobId: string,
    startingCount: number,
    llmConfig?: LLMRuntimeConfig
  ): Promise<LevelAnalysisResult> {
    // Use D1 ANALYTICS_DB for metrics
    const metrics = new MetricsFetcher(this.env.ANALYTICS_DB);
    const anthropicKey = await getSecret(this.env.ANTHROPIC_API_KEY);
    const geminiKey = await getSecret(this.env.GEMINI_API_KEY);
    const llm = new LLMRouter({
      anthropicApiKey: anthropicKey!,
      geminiApiKey: geminiKey!
    });
    const prompts = new PromptManager(this.env.AI_DB);
    const logger = new AnalysisLogger(this.env.AI_DB);
    const jobs = new JobManager(this.env.AI_DB);

    const entities = getEntitiesAtLevel(entityTree, level);
    const limiter = createLimiter(2); // Max 2 concurrent LLM calls

    const summaries: Record<string, string> = {};
    let processedCount = startingCount;

    // Process all entities at this level in parallel (with concurrency limit)
    await Promise.all(
      entities.map(entity =>
        limiter(async () => {
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
            llmConfig
          );

          summaries[entity.id] = summary;
          processedCount++;
          await jobs.updateProgress(jobId, processedCount, level as AnalysisLevel);
        })
      )
    );

    return { summaries, processedCount };
  }

  /**
   * Analyze a single entity
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
    llmConfig?: LLMRuntimeConfig
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

    // Log the call
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

    // Save summary
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
  ): Promise<{ crossPlatformSummary: string; platformSummaries: Record<string, string>; processedCount: number }> {
    // Use D1 ANALYTICS_DB for metrics
    const metrics = new MetricsFetcher(this.env.ANALYTICS_DB);
    const anthropicKey = await getSecret(this.env.ANTHROPIC_API_KEY);
    const geminiKey = await getSecret(this.env.GEMINI_API_KEY);
    const llm = new LLMRouter({
      anthropicApiKey: anthropicKey!,
      geminiApiKey: geminiKey!
    });
    const prompts = new PromptManager(this.env.AI_DB);
    const logger = new AnalysisLogger(this.env.AI_DB);
    const jobs = new JobManager(this.env.AI_DB);

    // Build platform summaries from account summaries
    const platformSummaries: Record<string, string> = {};
    for (const [key, account] of entityTree.accounts) {
      const platform = account.platform;
      const accountSummary = summariesByEntity[account.id] || '';
      platformSummaries[platform] = platformSummaries[platform]
        ? platformSummaries[platform] + '\n\n' + accountSummary
        : accountSummary;
    }

    // Calculate totals
    let totalSpendCents = 0;
    let totalRevenueCents = 0;

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
    }

    const totalSpend = `$${(totalSpendCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const blendedRoas = totalSpendCents > 0
      ? (totalRevenueCents / totalSpendCents).toFixed(2)
      : '0.00';

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
      processedCount
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

    await this.env.AI_DB.prepare(`
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
      const result = await this.env.AI_DB.prepare(`
        SELECT
          recommended_action,
          parameters,
          reason,
          status,
          CAST(julianday('now') - julianday(reviewed_at) AS INTEGER) as days_ago
        FROM ai_decisions
        WHERE org_id = ?
          AND status IN ('accepted', 'rejected')
          AND reviewed_at >= ?
        ORDER BY reviewed_at DESC
        LIMIT 30
      `).bind(orgId, cutoffDate.toISOString()).all<{
        recommended_action: string;
        parameters: string;
        reason: string;
        status: string;
        days_ago: number;
      }>();

      return (result.results || []).map(r => ({
        action: r.recommended_action,
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
    platformSummaries: Record<string, string>
  ): string {
    let prompt = `## Executive Summary\n${executiveSummary}\n\n`;
    prompt += '## Platform Summaries\n';
    for (const [platform, summary] of Object.entries(platformSummaries)) {
      prompt += `### ${platform.charAt(0).toUpperCase() + platform.slice(1)}\n${summary}\n\n`;
    }
    prompt += `Based on the analysis above:
1. FIRST: Generate at least one insight using general_insight to capture your strategic observations
2. THEN: Identify up to 3 specific action recommendations using set_budget, set_status, set_audience, or reallocate_budget
3. FINALLY: Call terminate_analysis when complete

Your output will be shown to users as a unified list: insight(s) first, then action recommendations.`;
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

## OUTPUT STRUCTURE (MANDATORY)
Your analysis MUST produce:
1. **ONE insight section** (REQUIRED) - Use general_insight to capture strategic observations. Multiple calls accumulate into a single document.
2. **Up to 3 action recommendations** (optional) - Use set_budget, set_status, set_audience, or reallocate_budget for specific changes.

The final output shown to users will be a unified list of up to 4 items: your accumulated insights (always shown first) plus any action recommendations.

## INSIGHT REQUIREMENTS
You MUST call general_insight at least once to provide strategic context. The insight should:
- Summarize cross-platform patterns or overall account health
- Note any data quality issues or gaps
- Highlight seasonal trends or market observations
- Include any strategic observations that don't fit the action tools

## ACTION RECOMMENDATIONS
For specific, executable changes:
1. PREFER action tools (set_budget, set_status, set_audience, reallocate_budget) over general observations
2. Focus on the most impactful changes first
3. For budget changes, stay within 30% of current values
4. For pausing: recommend for entities with poor ROAS (<1.5), high CPA, or declining trends
5. Be specific about entities - use their actual IDs and names

## TOOL BEHAVIOR
- general_insight: REQUIRED at least once. All calls ACCUMULATE into a single document. Does NOT count toward your 3 action recommendation limit.
- set_budget/set_status/set_audience/reallocate_budget: Up to 3 total action recommendations allowed.
- terminate_analysis: Call this when you have generated an insight AND made sufficient action recommendations (or determined no further actionable items exist).

## WHEN TO USE terminate_analysis
1. You have generated at least one insight AND made appropriate action recommendations
2. Data quality prevents meaningful further analysis
3. All major opportunities have been addressed
4. Continuing would produce low-confidence or repetitive suggestions

If you cannot find any actionable recommendations, you MUST still generate an insight explaining why (e.g., "Insufficient data for action recommendations" or "All campaigns performing within expected parameters").`;

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
    messages: any[],
    systemPrompt: string,
    existingRecommendations: Recommendation[],
    existingActionRecommendations: Recommendation[],
    maxActionRecommendations: number,
    enableExploration: boolean,
    existingAccumulatedInsightId: string | null,
    existingAccumulatedInsights: AccumulatedInsightData[],
    existingHasInsight: boolean
  ): Promise<AgenticIterationResult> {
    // Clone accumulated insights array to avoid mutation
    let accumulatedInsightId = existingAccumulatedInsightId;
    let accumulatedInsights = [...existingAccumulatedInsights];
    const actionRecommendations = [...existingActionRecommendations];
    const explorationExecutor = new ExplorationToolExecutor(this.env.ANALYTICS_DB);

    const tools = enableExploration
      ? [...getAnthropicTools(), ...getExplorationTools()]
      : getAnthropicTools();

    // Get API key
    const anthropicKey = await getSecret(this.env.ANTHROPIC_API_KEY);

    // Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey!,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODELS.OPUS,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        tools
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as any;

    const toolUses = result.content.filter((b: any) => b.type === 'tool_use');
    const textBlocks = result.content.filter((b: any) => b.type === 'text');

    // If no tool uses, we're done
    if (toolUses.length === 0) {
      return {
        messages,
        recommendations: existingRecommendations,
        shouldStop: true,
        stopReason: 'no_tool_calls',
        accumulatedInsightId: accumulatedInsightId || undefined,
        accumulatedInsights
      };
    }

    // Add assistant response
    const updatedMessages = [...messages, { role: 'assistant', content: result.content }];

    // Process tool uses
    const toolResults: any[] = [];
    const recommendations = [...existingRecommendations];
    let hitMaxActionRecommendations = false;

    for (const toolUse of toolUses) {
      // Handle terminate_analysis (control tool - NOT logged to DB)
      if (isTerminateAnalysisTool(toolUse.name)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ status: 'terminating', message: 'Analysis terminated by AI decision' })
        });

        // Return immediately with early termination
        if (toolResults.length > 0) {
          updatedMessages.push({ role: 'user', content: toolResults });
        }

        return {
          messages: updatedMessages,
          recommendations,
          shouldStop: true,
          stopReason: 'early_termination',
          terminationReason: toolUse.input.reason,
          accumulatedInsightId: accumulatedInsightId || undefined,
          accumulatedInsights
        };
      }

      // Handle general_insight (accumulation logic - does NOT count toward action limit)
      if (isGeneralInsightTool(toolUse.name)) {
        const input = toolUse.input;

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
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              status: 'appended',
              message: `Insight appended to accumulated document (${accumulatedInsights.length} total). You can continue adding insights - they don't count toward your action recommendation limit.`,
              total_insights: accumulatedInsights.length
            })
          });
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
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              status: 'created',
              message: 'Accumulated insight document created. Additional insights will append to this document. Insights are separate from action recommendations - you can add up to 3 action recommendations (set_budget, set_status, set_audience, reallocate_budget).',
              total_insights: 1,
              action_recommendations_remaining: maxActionRecommendations - actionRecommendations.length
            })
          });
        }
        continue;
      }

      // Handle exploration tools
      if (isExplorationTool(toolUse.name)) {
        const exploreResult = await explorationExecutor.execute(toolUse.name, toolUse.input, orgId);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(exploreResult)
        });
        continue;
      }

      // Handle action recommendation tools (set_budget, set_status, set_audience, reallocate_budget)
      // These count toward the action limit, separate from insights
      if (isRecommendationTool(toolUse.name) && !isGeneralInsightTool(toolUse.name) && !isTerminateAnalysisTool(toolUse.name)) {
        if (hitMaxActionRecommendations || actionRecommendations.length >= maxActionRecommendations) {
          hitMaxActionRecommendations = true;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              status: 'skipped',
              message: `Maximum action recommendations (${maxActionRecommendations}) reached. You can still add insights via general_insight.`
            })
          });
          continue;
        }

        const rec = parseToolCallToRecommendation(toolUse.name, toolUse.input);
        recommendations.push(rec);
        actionRecommendations.push(rec);  // Track action recs separately

        // Log to ai_decisions
        await this.logRecommendation(orgId, rec, runId);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            status: 'logged',
            action_recommendation_count: actionRecommendations.length,
            action_recommendations_remaining: maxActionRecommendations - actionRecommendations.length
          })
        });

        if (actionRecommendations.length >= maxActionRecommendations) {
          hitMaxActionRecommendations = true;
        }
      }
    }

    // Add tool results to messages
    if (toolResults.length > 0) {
      updatedMessages.push({ role: 'user', content: toolResults });
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
    enableExploration: boolean
  ): Promise<string | null> {
    const tools = enableExploration
      ? [...getAnthropicTools(), ...getExplorationTools()]
      : getAnthropicTools();

    // Get API key
    const anthropicKey = await getSecret(this.env.ANTHROPIC_API_KEY);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey!,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODELS.OPUS,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        tools
      })
    });

    if (!response.ok) {
      return null;
    }

    const result = await response.json() as any;
    const textBlocks = result.content.filter((b: any) => b.type === 'text');
    return textBlocks.map((b: any) => b.text).join('\n') || null;
  }

  /**
   * Log recommendation to ai_decisions table
   */
  private async logRecommendation(
    orgId: string,
    rec: Recommendation,
    analysisRunId: string
  ): Promise<void> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.env.AI_DB.prepare(`
      INSERT INTO ai_decisions (
        id, organization_id, tool, platform, entity_type, entity_id, entity_name,
        parameters, reason, predicted_impact, confidence, status, expires_at,
        supporting_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(
      id,
      orgId,
      rec.tool,
      rec.platform,
      rec.entity_type,
      rec.entity_id,
      rec.entity_name,
      JSON.stringify(rec.parameters),
      rec.reason,
      rec.predicted_impact,
      rec.confidence,
      expiresAt.toISOString(),
      JSON.stringify({ analysis_run_id: analysisRunId })
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

    await this.env.AI_DB.prepare(`
      INSERT INTO ai_decisions (
        id, organization_id, tool, platform, entity_type, entity_id, entity_name,
        parameters, reason, predicted_impact, confidence, status, expires_at,
        supporting_data
      ) VALUES (?, ?, 'accumulated_insight', 'general', 'insight', 'accumulated', ?, ?, ?, NULL, 'medium', 'pending', ?, ?)
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
    await this.env.AI_DB.prepare(`
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
