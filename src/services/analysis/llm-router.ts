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
  TOKEN_LIMITS_BY_LEVEL,
  CLAUDE_MODELS,
  GEMINI_MODELS
} from './llm-provider';

export interface LLMRouterConfig {
  anthropicApiKey: string;
  geminiApiKey: string;
  defaultProvider?: LLMProvider;
}

/**
 * Runtime LLM configuration from organization settings
 */
export interface LLMRuntimeConfig {
  defaultProvider: 'auto' | 'claude' | 'gemini';
  claudeModel: 'opus' | 'sonnet' | 'haiku';
  geminiModel: 'pro' | 'flash' | 'flash_lite';
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
   *
   * If runtimeConfig is provided, uses the user's configured provider/model instead.
   */
  async generateSummaryForLevel(
    level: AnalysisLevel,
    systemPrompt: string,
    userPrompt: string,
    overrideOptions?: Partial<GenerateOptions>,
    runtimeConfig?: LLMRuntimeConfig
  ): Promise<LLMResponse> {
    // Resolve provider and model from runtime config or defaults
    const { provider, model } = runtimeConfig
      ? this.resolveFromConfig(level, runtimeConfig)
      : DEFAULT_MODEL_BY_LEVEL[level];

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
   * Resolve provider and model from runtime configuration
   *
   * If defaultProvider is 'auto', uses the cost-optimized defaults.
   * Otherwise uses the specified provider with the configured model.
   */
  private resolveFromConfig(
    level: AnalysisLevel,
    config: LLMRuntimeConfig
  ): { provider: LLMProvider; model: string } {
    // Auto mode uses the cost-optimized defaults per level
    if (config.defaultProvider === 'auto') {
      return DEFAULT_MODEL_BY_LEVEL[level];
    }

    // Map model names to actual model IDs
    const claudeModelMap: Record<string, string> = {
      opus: CLAUDE_MODELS.OPUS,
      sonnet: CLAUDE_MODELS.SONNET,
      haiku: CLAUDE_MODELS.HAIKU
    };

    const geminiModelMap: Record<string, string> = {
      pro: GEMINI_MODELS.PRO,
      flash: GEMINI_MODELS.FLASH,
      flash_lite: GEMINI_MODELS.FLASH_LITE
    };

    // Use specified provider with configured model
    if (config.defaultProvider === 'claude') {
      return {
        provider: 'claude',
        model: claudeModelMap[config.claudeModel] || CLAUDE_MODELS.HAIKU
      };
    }

    return {
      provider: 'gemini',
      model: geminiModelMap[config.geminiModel] || GEMINI_MODELS.FLASH
    };
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
