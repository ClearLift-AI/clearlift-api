/**
 * Agentic Loop
 *
 * After generating the executive summary, enter an agentic loop where:
 * 1. LLM can make tool calls (recommendations)
 * 2. Tool results are appended and we call again
 * 3. Stop when 4 recommendations accumulated OR no more tool calls
 * 4. Log recommendations to ai_decisions table
 */

import { structuredLog } from '../../utils/structured-logger';
import {
  RECOMMENDATION_TOOLS,
  getAnthropicTools,
  isRecommendationTool,
  parseToolCallToRecommendation,
  Recommendation
} from './recommendation-tools';
import {
  getExplorationTools,
  getExplorationToolsForOrg,
  isExplorationTool,
  ExplorationToolExecutor
} from './exploration-tools';
import { CLAUDE_MODELS } from './llm-provider';

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

interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<AnthropicToolUse | AnthropicTextBlock | { type: 'tool_result'; tool_use_id: string; content: string }>;
}

interface AgenticLoopResult {
  finalSummary: string;
  recommendations: Recommendation[];
  iterations: number;
  stoppedReason: 'max_recommendations' | 'no_tool_calls' | 'max_iterations';
}

/**
 * Runtime configuration for the agentic loop
 */
export interface AgenticLoopConfig {
  maxRecommendations?: number;
  enableExploration?: boolean;
  days?: number;  // Analysis date range - LLM should use this for exploration queries
}

interface RecentRecommendation {
  action: string;
  parameters: string;
  reason: string;
  status: 'accepted' | 'rejected';
  days_ago: number;
  reviewed_at: string;
}

export class AgenticLoop {
  private readonly maxIterations = 200;  // Allow extensive exploration before recommendations
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiVersion = '2023-06-01';
  private explorationExecutor: ExplorationToolExecutor;

  constructor(
    private anthropicApiKey: string,
    private db: D1Database,
    private analyticsDb: D1Database
  ) {
    this.explorationExecutor = new ExplorationToolExecutor(analyticsDb);
  }

  /** @deprecated Superseded by analysis-workflow.ts Workflow. Only read helpers (getLatestAnalysis, getEntitySummary) are still live. */
  async run(
    orgId: string,
    executiveSummary: string,
    platformSummaries: Record<string, string>,
    analysisRunId: string,
    customInstructions?: string | null,
    config?: AgenticLoopConfig
  ): Promise<AgenticLoopResult> {
    const recommendations: Recommendation[] = [];
    let iterations = 0;
    const maxRecommendations = config?.maxRecommendations ?? 4;
    const enableExploration = config?.enableExploration !== false;
    const days = config?.days ?? 7;  // Default to 7 days if not specified

    // Fetch recent recommendation history to avoid repetition
    const recentRecs = await this.getRecentRecommendations(orgId);

    // Build initial context with platform summaries
    const contextPrompt = this.buildContextPrompt(executiveSummary, platformSummaries);

    // Initial messages
    const messages: AnthropicMessage[] = [
      {
        role: 'user',
        content: contextPrompt
      }
    ];

    // Build system prompt with optional custom instructions
    let systemPrompt = `You are an expert digital advertising strategist. Based on the analysis provided, identify actionable optimizations.

IMPORTANT DATE RANGE: This analysis covers the LAST ${days} DAYS only. When using exploration tools (query_ad_metrics, calculate with scope=compare_entities), you MUST use days=${days} to stay consistent with the analysis period.

IMPORTANT DATA UNITS: All monetary values in raw data are in CENTS (not dollars). When interpreting spend_cents or conversion_value_cents:
- spend_cents: 100 = $1.00
- spend_cents: 1000000 = $10,000.00
- To convert to dollars: divide by 100

CRITICAL - BUDGET vs SPEND:
- BUDGET is the configured limit (daily or lifetime budget setting on the campaign/adset)
- SPEND is what was actually spent during the analysis period
- They are NOT the same! A campaign with $100/day budget might only spend $20 if ads aren't competitive.
- ALWAYS use get_entity_budget to check actual budget before recommending budget changes.

MATH TOOLS AVAILABLE:
- get_entity_budget: Get actual configured budget for an entity (not spend!)
- calculate_budget_change: Compute exact new budget from current budget + percentage change
- calculate_percentage_change: Compute percentage difference between two values

FOR BUDGET RECOMMENDATIONS:
1. First call get_entity_budget to get the actual current budget
2. Then call calculate_budget_change with the budget and your desired percentage
3. Use the returned new_budget_cents in your set_budget recommendation
4. If budget is $0, do NOT recommend percentage-based changes - use general_insight to flag the issue

IMPORTANT RULES:
1. PREFER actionable recommendations (set_budget, set_status, set_audience) over general_insight
2. Focus on the most impactful changes first
3. For budget changes, stay within 30% of current values
4. For pausing: recommend for entities with poor ROAS (<1.5), high CPA, or declining performance trends
5. Be specific about entities - use their actual IDs and names from the data
6. Only use general_insight for cross-platform patterns or issues that genuinely cannot be addressed with the other tools
7. NEVER recommend a budget amount without first using get_entity_budget and calculate_budget_change

After analyzing the data, use the available tools to make specific recommendations.
If you see underperforming campaigns or ads, use set_status to recommend pausing them.`;

    // Append custom instructions if provided
    if (customInstructions && customInstructions.trim()) {
      systemPrompt += `\n\n## CUSTOM BUSINESS CONTEXT (from the user)\nThe following is specific context about this business that you MUST consider when making recommendations:\n\n${customInstructions.trim()}`;
    }

    // Append recent recommendation history to prevent repetition
    systemPrompt += this.formatRecentRecommendations(recentRecs);

    while (iterations < this.maxIterations) {
      iterations++;

      // Call Claude with tools
      const response = await this.callWithTools(systemPrompt, messages, enableExploration, orgId);

      // Extract tool uses and text from response
      const toolUses = response.content.filter(
        (block): block is AnthropicToolUse => block.type === 'tool_use'
      );
      const textBlocks = response.content.filter(
        (block): block is AnthropicTextBlock => block.type === 'text'
      );

      // If no tool uses, we're done
      if (toolUses.length === 0) {
        const finalText = textBlocks.map(b => b.text).join('\n');
        return {
          finalSummary: finalText || executiveSummary,
          recommendations,
          iterations,
          stoppedReason: 'no_tool_calls'
        };
      }

      // Add assistant response to messages
      messages.push({
        role: 'assistant',
        content: response.content
      });

      // Process tool uses - MUST provide results for ALL tool_uses before continuing
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
      let hitMaxRecommendations = false;

      for (const toolUse of toolUses) {
        // Handle exploration tools (unlimited use)
        if (isExplorationTool(toolUse.name)) {
          const result = await this.explorationExecutor.execute(toolUse.name, toolUse.input, orgId);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result)
          });
          continue;
        }

        // Handle recommendation tools (capped at maxRecommendations)
        if (isRecommendationTool(toolUse.name)) {
          // Check if we've already hit max - skip logging but still return a result
          if (hitMaxRecommendations || recommendations.length >= maxRecommendations) {
            hitMaxRecommendations = true;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                status: 'skipped',
                message: `Maximum recommendations (${maxRecommendations}) already reached. This recommendation was not logged.`
              })
            });
            continue;
          }

          // Parse and store recommendation
          const rec = parseToolCallToRecommendation(toolUse.name, toolUse.input);
          recommendations.push(rec);

          // Log to ai_decisions
          await this.logRecommendation(orgId, rec, analysisRunId);

          // Add success result
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              status: 'logged',
              message: `Recommendation logged: ${rec.tool} for ${rec.entity_name}`,
              recommendation_count: recommendations.length
            })
          });

          // Check if we've hit max recommendations
          if (recommendations.length >= maxRecommendations) {
            hitMaxRecommendations = true;
          }
        }
      }

      // Add all tool results to messages
      if (toolResults.length > 0) {
        messages.push({
          role: 'user',
          content: toolResults
        });
      }

      // If we hit max, get final summary and return
      if (hitMaxRecommendations) {
        // One more call to get final summary
        const finalResponse = await this.callWithTools(
          systemPrompt + `\n\nYou have made ${maxRecommendations} recommendations which is the maximum. Provide a brief final summary.`,
          messages,
          enableExploration,
          orgId
        );

        const finalText = finalResponse.content
          .filter((block): block is AnthropicTextBlock => block.type === 'text')
          .map(b => b.text)
          .join('\n');

        return {
          finalSummary: finalText || executiveSummary,
          recommendations,
          iterations,
          stoppedReason: 'max_recommendations'
        };
      }
    }

    // Hit max iterations
    return {
      finalSummary: executiveSummary,
      recommendations,
      iterations,
      stoppedReason: 'max_iterations'
    };
  }

  /**
   * Build the context prompt with all platform summaries
   */
  private buildContextPrompt(
    executiveSummary: string,
    platformSummaries: Record<string, string>
  ): string {
    let prompt = `## Executive Summary\n${executiveSummary}\n\n`;

    prompt += '## Platform Summaries\n';
    for (const [platform, summary] of Object.entries(platformSummaries)) {
      prompt += `### ${platform.charAt(0).toUpperCase() + platform.slice(1)}\n${summary}\n\n`;
    }

    prompt += `Based on the analysis above, identify up to 4 actionable recommendations. PRIORITIZE using set_budget, set_status, or set_audience tools for specific optimizations. If you see underperforming entities, use set_status to recommend pausing them. Only use general_insight for strategic observations that cannot be addressed with the other tools.`;

    return prompt;
  }

  /**
   * Call Claude API with tools
   */
  private async callWithTools(
    systemPrompt: string,
    messages: AnthropicMessage[],
    enableExploration: boolean = true,
    orgId?: string
  ): Promise<{
    content: Array<AnthropicToolUse | AnthropicTextBlock>;
    stop_reason: string;
  }> {
    // Build tools list - always include recommendation tools, conditionally include exploration
    // Dynamic filtering: only include tools relevant to org's active connectors
    const explorationTools = enableExploration && orgId
      ? await getExplorationToolsForOrg(this.analyticsDb, orgId)
      : enableExploration ? getExplorationTools() : [];
    const tools = [...getAnthropicTools(), ...explorationTools];

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.anthropicApiKey,
        'anthropic-version': this.apiVersion
      },
      body: JSON.stringify({
        model: CLAUDE_MODELS.OPUS,  // Use Opus for agentic reasoning
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

    return await response.json();
  }

  /**
   * Fetch recently reviewed recommendations (accepted/rejected in last 30 days)
   * These are passed to the LLM so it understands user preferences and doesn't repeat itself
   */
  private async getRecentRecommendations(
    orgId: string,
    lookbackDays: number = 30
  ): Promise<RecentRecommendation[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

    try {
      const result = await this.db.prepare(`
        SELECT
          tool,
          parameters,
          reason,
          status,
          reviewed_at,
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
        reviewed_at: string;
        days_ago: number;
      }>();

      return (result.results || []).map(r => ({
        action: r.tool,
        parameters: r.parameters,
        reason: r.reason,
        status: r.status as 'accepted' | 'rejected',
        days_ago: r.days_ago,
        reviewed_at: r.reviewed_at
      }));
    } catch (err) {
      // If query fails (e.g., schema mismatch), return empty array
      structuredLog('ERROR', 'Failed to fetch recent recommendations', { service: 'agentic-loop', error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Format recent recommendations for LLM context
   */
  private formatRecentRecommendations(recs: RecentRecommendation[]): string {
    if (recs.length === 0) {
      return '';
    }

    const accepted = recs.filter(r => r.status === 'accepted');
    const rejected = recs.filter(r => r.status === 'rejected');

    let context = '\n\n## RECENT RECOMMENDATION HISTORY (last 30 days)';

    if (accepted.length > 0) {
      context += '\n\n### IMPLEMENTED (do not recommend similar changes):';
      for (const r of accepted) {
        let params = '';
        try {
          const p = JSON.parse(r.parameters);
          params = Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(', ');
        } catch {
          params = r.parameters;
        }
        context += `\n- ${r.action} (${params}) - ${r.days_ago} days ago`;
      }
    }

    if (rejected.length > 0) {
      context += '\n\n### REJECTED BY USER (avoid similar recommendations):';
      for (const r of rejected) {
        let params = '';
        try {
          const p = JSON.parse(r.parameters);
          params = Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(', ');
        } catch {
          params = r.parameters;
        }
        context += `\n- ${r.action} (${params}) - ${r.days_ago} days ago: "${r.reason}"`;
      }
    }

    return context;
  }

  /**
   * Log recommendation to ai_decisions table
   */
  private async logRecommendation(
    orgId: string,
    rec: Recommendation,
    analysisRunId: string,
    simulationResult?: { current_state: any; simulated_state: any; diminishing_returns_model?: any; confidence: string } | null
  ): Promise<void> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);  // 7-day expiry

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

    await this.db.prepare(`
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
}
