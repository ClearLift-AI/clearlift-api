/**
 * LLM Router
 *
 * Routes analysis requests to the appropriate LLM provider (Claude or Gemini)
 * based on analysis level or explicit options
 */

import { AnthropicClient } from './anthropic-client';
import { GeminiClient } from './gemini-client';
import {
  LLMClient,
  LLMResponse,
  GenerateOptions,
  LLMProvider,
  AnalysisLevel,
  DEFAULT_MODEL_BY_LEVEL,
  TOKEN_LIMITS_BY_LEVEL
} from './llm-provider';

export interface LLMRouterConfig {
  anthropicApiKey: string;
  geminiApiKey: string;
  defaultProvider?: LLMProvider;
}

export class LLMRouter implements LLMClient {
  private anthropic: AnthropicClient;
  private gemini: GeminiClient;
  private defaultProvider: LLMProvider;

  constructor(config: LLMRouterConfig) {
    this.anthropic = new AnthropicClient(config.anthropicApiKey);
    this.gemini = new GeminiClient(config.geminiApiKey);
    this.defaultProvider = config.defaultProvider || 'claude';
  }

  /**
   * Generate a summary using the appropriate LLM based on options or default
   */
  async generateSummary(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions
  ): Promise<LLMResponse> {
    const provider = options?.provider ?? this.defaultProvider;
    const client = provider === 'claude' ? this.anthropic : this.gemini;

    return client.generateSummary(systemPrompt, userPrompt, options);
  }

  /**
   * Generate a summary using the optimal model for the given analysis level
   *
   * This method automatically selects the best model based on:
   * - Ad/Adset: Gemini Flash-Lite (cheapest, high volume)
   * - Campaign: Claude Haiku (good synthesis)
   * - Account: Gemini 3 Pro (good aggregation)
   * - Cross-platform: Claude Opus (best quality for executive summaries)
   */
  async generateSummaryForLevel(
    level: AnalysisLevel,
    systemPrompt: string,
    userPrompt: string,
    overrideOptions?: Partial<GenerateOptions>
  ): Promise<LLMResponse> {
    const { provider, model } = DEFAULT_MODEL_BY_LEVEL[level];
    const maxTokens = TOKEN_LIMITS_BY_LEVEL[level];

    const options: GenerateOptions = {
      provider,
      model,
      maxTokens,
      temperature: 0.3,
      ...overrideOptions
    };

    return this.generateSummary(systemPrompt, userPrompt, options);
  }

  /**
   * Get the Anthropic client directly (for advanced use cases)
   */
  getAnthropicClient(): AnthropicClient {
    return this.anthropic;
  }

  /**
   * Get the Gemini client directly (for advanced use cases)
   */
  getGeminiClient(): GeminiClient {
    return this.gemini;
  }
}
