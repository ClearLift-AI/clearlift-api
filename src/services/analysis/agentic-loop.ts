/**
 * Agentic Loop
 *
 * After generating the executive summary, enter an agentic loop where:
 * 1. LLM can make tool calls (recommendations)
 * 2. Tool results are appended and we call again
 * 3. Stop when 3 recommendations accumulated OR no more tool calls
 * 4. Log recommendations to ai_decisions table
 */

import {
  RECOMMENDATION_TOOLS,
  getAnthropicTools,
  isRecommendationTool,
  parseToolCallToRecommendation,
  Recommendation
} from './recommendation-tools';
import { CLAUDE_MODELS } from './llm-provider';

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

export class AgenticLoop {
  private readonly maxRecommendations = 3;
  private readonly maxIterations = 5;  // Safety limit
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiVersion = '2023-06-01';

  constructor(
    private anthropicApiKey: string,
    private db: D1Database
  ) {}

  /**
   * Run the agentic loop starting from the executive summary
   */
  async run(
    orgId: string,
    executiveSummary: string,
    platformSummaries: Record<string, string>,
    analysisRunId: string
  ): Promise<AgenticLoopResult> {
    const recommendations: Recommendation[] = [];
    let iterations = 0;

    // Build initial context with platform summaries
    const contextPrompt = this.buildContextPrompt(executiveSummary, platformSummaries);

    // Initial messages
    const messages: AnthropicMessage[] = [
      {
        role: 'user',
        content: contextPrompt
      }
    ];

    const systemPrompt = `You are an expert digital advertising strategist. Based on the analysis provided, identify actionable optimizations.

IMPORTANT RULES:
1. Only make recommendations when you have HIGH confidence based on clear data patterns
2. Focus on the most impactful changes first
3. For budget changes, stay within 30% of current values
4. For pausing, only recommend for entities with clear underperformance (ROAS < 1.0, declining trends)
5. Be specific about entities - use their actual IDs and names from the data

After analyzing the data, you may use the available tools to make specific recommendations.
If you have no confident recommendations to make, simply provide a brief final summary without tool calls.`;

    while (iterations < this.maxIterations) {
      iterations++;

      // Call Claude with tools
      const response = await this.callWithTools(systemPrompt, messages);

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

      // Process tool uses
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

      for (const toolUse of toolUses) {
        if (isRecommendationTool(toolUse.name)) {
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
          if (recommendations.length >= this.maxRecommendations) {
            // Add tool results and get final summary
            messages.push({
              role: 'user',
              content: toolResults
            });

            // One more call to get final summary
            const finalResponse = await this.callWithTools(
              systemPrompt + '\n\nYou have made 3 recommendations which is the maximum. Provide a brief final summary.',
              messages
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
      }

      // Add tool results for next iteration
      if (toolResults.length > 0) {
        messages.push({
          role: 'user',
          content: toolResults
        });
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

    prompt += `Based on the analysis above, identify up to 3 high-confidence actionable recommendations. Use the available tools to log specific budget or status change recommendations. Only recommend changes you are confident will improve performance.`;

    return prompt;
  }

  /**
   * Call Claude API with tools
   */
  private async callWithTools(
    systemPrompt: string,
    messages: AnthropicMessage[]
  ): Promise<{
    content: Array<AnthropicToolUse | AnthropicTextBlock>;
    stop_reason: string;
  }> {
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
        tools: getAnthropicTools()
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
