/**
 * Agentic Loop
 *
 * After generating the executive summary, enter an agentic loop where:
 * 1. LLM can make tool calls (recommendations)
 * 2. Tool results are appended and we call again
 * 3. Stop when 4 recommendations accumulated OR no more tool calls
 * 4. Log recommendations to ai_decisions table
 */

import {
  RECOMMENDATION_TOOLS,
  getAnthropicTools,
  isRecommendationTool,
  parseToolCallToRecommendation,
  Recommendation
} from './recommendation-tools';
import {
  getExplorationTools,
  isExplorationTool,
  ExplorationToolExecutor
} from './exploration-tools';
import { CLAUDE_MODELS } from './llm-provider';
import { SupabaseClient } from '../../services/supabase';

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
}

export class AgenticLoop {
  private readonly maxIterations = 200;  // Allow extensive exploration before recommendations
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiVersion = '2023-06-01';
  private explorationExecutor: ExplorationToolExecutor | null = null;

  constructor(
    private anthropicApiKey: string,
    private db: D1Database,
    private supabase?: SupabaseClient
  ) {
    if (supabase) {
      this.explorationExecutor = new ExplorationToolExecutor(supabase);
    }
  }

  /**
   * Run the agentic loop starting from the executive summary
   */
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

IMPORTANT RULES:
1. PREFER actionable recommendations (set_budget, set_status, set_audience) over general_insight
2. Focus on the most impactful changes first
3. For budget changes, stay within 30% of current values
4. For pausing: recommend for entities with poor ROAS (<1.5), high CPA, or declining performance trends
5. Be specific about entities - use their actual IDs and names from the data
6. Only use general_insight for cross-platform patterns or issues that genuinely cannot be addressed with the other tools

After analyzing the data, use the available tools to make specific recommendations.
If you see underperforming campaigns or ads, use set_status to recommend pausing them.`;

    // Append custom instructions if provided
    if (customInstructions && customInstructions.trim()) {
      systemPrompt += `\n\n## CUSTOM BUSINESS CONTEXT (from the user)\nThe following is specific context about this business that you MUST consider when making recommendations:\n\n${customInstructions.trim()}`;
    }

    while (iterations < this.maxIterations) {
      iterations++;

      // Call Claude with tools
      const response = await this.callWithTools(systemPrompt, messages, enableExploration);

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
        if (isExplorationTool(toolUse.name) && this.explorationExecutor) {
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
          enableExploration
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
    enableExploration: boolean = true
  ): Promise<{
    content: Array<AnthropicToolUse | AnthropicTextBlock>;
    stop_reason: string;
  }> {
    // Build tools list - always include recommendation tools, conditionally include exploration
    const tools = enableExploration
      ? [...getAnthropicTools(), ...getExplorationTools()]
      : getAnthropicTools();

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
   * Log recommendation to ai_decisions table
   */
  private async logRecommendation(
    orgId: string,
    rec: Recommendation,
    analysisRunId: string
  ): Promise<void> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);  // 7-day expiry

    await this.db.prepare(`
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
}
