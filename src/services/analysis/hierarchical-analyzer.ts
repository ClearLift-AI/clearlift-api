/**
 * Hierarchical Analyzer
 *
 * Orchestrates bottom-up analysis of ad entities
 * Ad → Adset → Campaign → Account → Cross-Platform
 */

import { EntityTreeBuilder, Entity, EntityTree, AccountEntity, Platform, EntityLevel } from './entity-tree';
import { MetricsFetcher, TimeseriesMetric, DateRange } from './metrics-fetcher';
import { LLMRouter, LLMRuntimeConfig } from './llm-router';
import { PromptManager } from './prompt-manager';
import { AnalysisLogger } from './analysis-logger';
import { JobManager } from './job-manager';
import { AnalysisLevel } from './llm-provider';
import { AgenticLoop, AgenticLoopConfig } from './agentic-loop';
import { Recommendation } from './recommendation-tools';

// D1Database type from Cloudflare Workers (matches worker-configuration.d.ts)
type D1Database = {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
};

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  error?: string;
  meta?: {
    changed_db: boolean;
    changes: number;
    last_row_id: number;
    duration: number;
    rows_read: number;
    rows_written: number;
  };
}

interface D1ExecResult {
  count: number;
  duration: number;
}

/**
 * Configuration for analysis run from organization settings
 */
export interface AnalysisConfig {
  llm?: LLMRuntimeConfig;
  agentic?: AgenticLoopConfig;
}

// Use p-limit pattern for concurrency control
const createLimiter = (concurrency: number) => {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const resolve = queue.shift()!;
      resolve();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          active--;
          next();
        }
      };

      queue.push(run);
      next();
    });
  };
};

export interface AnalysisSummary {
  id: string;
  organization_id: string;
  level: AnalysisLevel;
  platform: string | null;
  entity_id: string;
  entity_name: string;
  summary: string;
  metrics_snapshot: string;
  days: number;
  analysis_run_id: string;
  created_at: string;
}

export interface AnalysisResult {
  runId: string;
  crossPlatformSummary: string;
  platformSummaries: Record<string, string>;
  entityCount: number;
  durationMs: number;
  recommendations: Recommendation[];
  agenticLoopIterations: number;
  agenticLoopStoppedReason: 'max_recommendations' | 'no_tool_calls' | 'max_iterations';
}

export class HierarchicalAnalyzer {
  private llmLimiter = createLimiter(2);  // Max 2 concurrent LLM calls (reduced for preview model rate limits)
  private agenticLoop: AgenticLoop;

  constructor(
    private entityTree: EntityTreeBuilder,
    private metrics: MetricsFetcher,
    private llm: LLMRouter,
    private prompts: PromptManager,
    private logger: AnalysisLogger,
    private jobs: JobManager,
    private db: D1Database,
    private analyticsDb: D1Database,
    anthropicApiKey: string
  ) {
    this.agenticLoop = new AgenticLoop(anthropicApiKey, db, analyticsDb);
  }

  /**
   * Run full hierarchical analysis for an organization
   */
  async analyzeOrganization(
    orgId: string,
    days: number = 7,
    jobId?: string,
    customInstructions?: string | null,
    config?: AnalysisConfig
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    const runId = crypto.randomUUID().replace(/-/g, '');

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const dateRange: DateRange = {
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0]
    };

    // Build entity tree
    const tree = await this.entityTree.buildTree(orgId);

    // Update job with total entities
    // +2 for cross_platform summary and recommendations steps
    if (jobId) {
      await this.jobs.startJob(jobId, tree.totalEntities + 2);
    }

    // Storage for summaries at each level
    const summariesByEntity = new Map<string, string>();
    let processedCount = 0;

    // Process levels bottom-up
    const levels: AnalysisLevel[] = ['ad', 'adset', 'campaign', 'account'];

    for (const level of levels) {
      const entities = this.entityTree.getEntitiesAtLevel(tree, level as EntityLevel);

      // Process all entities at this level in parallel (with concurrency limit)
      const levelSummaries = await Promise.all(
        entities.map(entity =>
          this.llmLimiter(async () => {
            const summary = await this.analyzeEntity(
              orgId,
              entity,
              level,
              dateRange,
              summariesByEntity,
              runId,
              days,
              config?.llm
            );
            processedCount++;

            if (jobId) {
              await this.jobs.updateProgress(jobId, processedCount, level);
            }

            return { entityId: entity.id, summary };
          })
        )
      );

      // Store summaries for parent consumption
      for (const { entityId, summary } of levelSummaries) {
        summariesByEntity.set(entityId, summary);
      }
    }

    // Generate cross-platform summary
    const platformSummaries: Record<string, string> = {};
    for (const [key, account] of tree.accounts) {
      const platform = account.platform;
      const accountSummary = summariesByEntity.get(account.id) || '';
      platformSummaries[platform] = platformSummaries[platform]
        ? platformSummaries[platform] + '\n\n' + accountSummary
        : accountSummary;
    }

    const crossPlatformSummary = await this.generateCrossPlatformSummary(
      orgId,
      tree,
      platformSummaries,
      dateRange,
      runId,
      days,
      config?.llm
    );
    processedCount++;

    if (jobId) {
      await this.jobs.updateProgress(jobId, processedCount, 'cross_platform');
    }

    // Run agentic loop to generate recommendations
    if (jobId) {
      await this.jobs.updateProgress(jobId, processedCount, 'recommendations');
    }

    const agenticResult = await this.agenticLoop.run(
      orgId,
      crossPlatformSummary,
      platformSummaries,
      runId,
      customInstructions,
      {
        ...config?.agentic,
        days  // Pass the analysis date range to constrain exploration queries
      }
    );

    // Mark recommendations step complete
    processedCount++;
    if (jobId) {
      await this.jobs.updateProgress(jobId, processedCount, 'recommendations');
    }

    const durationMs = Date.now() - startTime;

    return {
      runId,
      crossPlatformSummary: agenticResult.finalSummary,  // Use final summary from agentic loop
      platformSummaries,
      entityCount: tree.totalEntities,
      durationMs,
      recommendations: agenticResult.recommendations,
      agenticLoopIterations: agenticResult.iterations,
      agenticLoopStoppedReason: agenticResult.stoppedReason
    };
  }

  /**
   * Analyze a single entity
   */
  private async analyzeEntity(
    orgId: string,
    entity: Entity,
    level: AnalysisLevel,
    dateRange: DateRange,
    summariesByEntity: Map<string, string>,
    runId: string,
    days: number,
    llmConfig?: LLMRuntimeConfig
  ): Promise<string> {
    // Get metrics for this entity
    let metrics: TimeseriesMetric[];
    if (entity.children.length > 0) {
      // Parent entity: aggregate child metrics
      const childIds = entity.children.map(c => c.id);
      metrics = await this.metrics.fetchAggregatedMetrics(
        entity.platform,
        entity.level,
        childIds,
        dateRange
      );
    } else {
      // Leaf entity: fetch directly
      metrics = await this.metrics.fetchMetrics(
        entity.platform,
        entity.level,
        entity.id,
        dateRange
      );
    }

    // Get child summaries for non-leaf levels
    const childSummaries = entity.children.map(child => ({
      name: child.name,
      summary: summariesByEntity.get(child.id) || 'No summary available',
      platform: child.platform
    }));

    // Get prompt template
    const template = await this.prompts.getTemplateForLevel(level, entity.platform);
    if (!template) {
      return `Analysis unavailable: No template for ${level}`;
    }

    // Build variables for hydration
    const variables: Record<string, string> = {
      days: String(days),
      platform: entity.platform,
      metrics_table: this.prompts.formatMetricsTable(metrics),
      child_summaries: this.prompts.formatChildSummaries(childSummaries)
    };

    // Add level-specific name variable
    if (level === 'ad') variables.ad_name = entity.name;
    if (level === 'adset') variables.adset_name = entity.name;
    if (level === 'campaign') variables.campaign_name = entity.name;
    if (level === 'account') variables.account_name = entity.name;

    // Hydrate template
    const userPrompt = this.prompts.hydrateTemplate(template, variables);
    const systemPrompt = 'You are an expert digital advertising analyst. Be concise and actionable.';

    // Generate summary
    const response = await this.llm.generateSummaryForLevel(
      level,
      systemPrompt,
      userPrompt,
      undefined,  // overrideOptions
      llmConfig
    );

    // Log the call
    await this.logger.logCall({
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
      metrics,
      days
    );

    return response.content;
  }

  /**
   * Generate cross-platform executive summary
   */
  private async generateCrossPlatformSummary(
    orgId: string,
    tree: EntityTree,
    platformSummaries: Record<string, string>,
    dateRange: DateRange,
    runId: string,
    days: number,
    llmConfig?: LLMRuntimeConfig
  ): Promise<string> {
    // Calculate totals across platforms
    let totalSpendCents = 0;
    let totalRevenueCents = 0;

    for (const account of tree.accounts.values()) {
      const childIds = account.children.map(c => c.id);
      const metrics = await this.metrics.fetchAggregatedMetrics(
        account.platform,
        'account',  // Fixed: was 'campaign' which caused wrong table lookup
        childIds,
        dateRange
      );
      const totals = this.metrics.sumMetrics(metrics);
      totalSpendCents += totals.spend_cents;
      totalRevenueCents += totals.conversion_value_cents;

      // Debug logging for date filtering verification
      console.log(`[Analysis] Account ${account.id} (${account.platform}): ${metrics.length} metric days in range ${dateRange.start} to ${dateRange.end}, spend: $${(totals.spend_cents / 100).toFixed(2)}`);
    }

    const totalSpend = `$${(totalSpendCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const blendedRoas = totalSpendCents > 0
      ? (totalRevenueCents / totalSpendCents).toFixed(2)
      : '0.00';

    // Format platform summaries
    const childSummaries = Object.entries(platformSummaries).map(([platform, summary]) => ({
      name: platform.charAt(0).toUpperCase() + platform.slice(1),
      summary,
      platform
    }));

    // Get template
    const template = await this.prompts.getTemplateForLevel('cross_platform');
    if (!template) {
      return 'Cross-platform analysis unavailable: No template configured';
    }

    // Hydrate
    const variables: Record<string, string> = {
      days: String(days),
      org_name: `Organization ${orgId.substring(0, 8)}`,
      total_spend: totalSpend,
      blended_roas: blendedRoas,
      child_summaries: this.prompts.formatChildSummaries(childSummaries)
    };

    const userPrompt = this.prompts.hydrateTemplate(template, variables);
    const systemPrompt = 'You are a strategic marketing advisor. Provide executive-level insights.';

    // Generate with Opus (or configured model)
    const response = await this.llm.generateSummaryForLevel(
      'cross_platform',
      systemPrompt,
      userPrompt,
      undefined,  // overrideOptions
      llmConfig
    );

    // Log
    await this.logger.logCall({
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

    return response.content;
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
    expiresAt.setHours(expiresAt.getHours() + 24);  // 24-hour expiry

    await this.db.prepare(`
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
   * Get latest analysis results for an organization
   */
  async getLatestAnalysis(orgId: string): Promise<{
    runId: string;
    crossPlatformSummary: AnalysisSummary | null;
    platformSummaries: AnalysisSummary[];
    createdAt: string;
  } | null> {
    // Get the most recent run
    const latestRun = await this.db.prepare(`
      SELECT DISTINCT analysis_run_id, created_at
      FROM analysis_summaries
      WHERE organization_id = ? AND level = 'cross_platform'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(orgId).first<{ analysis_run_id: string; created_at: string }>();

    if (!latestRun) return null;

    // Get all summaries for this run
    const summaries = await this.db.prepare(`
      SELECT * FROM analysis_summaries
      WHERE analysis_run_id = ?
      ORDER BY level, entity_name
    `).bind(latestRun.analysis_run_id).all<AnalysisSummary>();

    const results = summaries.results || [];
    const crossPlatform = results.find(s => s.level === 'cross_platform') || null;
    const platforms = results.filter(s => s.level === 'account');

    return {
      runId: latestRun.analysis_run_id,
      crossPlatformSummary: crossPlatform,
      platformSummaries: platforms,
      createdAt: latestRun.created_at
    };
  }

  /**
   * Get summary for a specific entity
   */
  async getEntitySummary(
    orgId: string,
    level: AnalysisLevel,
    entityId: string
  ): Promise<AnalysisSummary | null> {
    const result = await this.db.prepare(`
      SELECT * FROM analysis_summaries
      WHERE organization_id = ? AND level = ? AND entity_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(orgId, level, entityId).first<AnalysisSummary>();

    return result || null;
  }
}
