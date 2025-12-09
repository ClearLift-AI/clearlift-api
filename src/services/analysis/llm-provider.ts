/**
 * LLM Provider Interface and Types
 *
 * Common interface for Claude (Anthropic) and Gemini (Google) clients
 */

export type LLMProvider = 'claude' | 'gemini';

export type AnalysisLevel = 'ad' | 'adset' | 'campaign' | 'account' | 'cross_platform' | 'recommendations';

export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  provider: LLMProvider;
  model: string;
}

export interface GenerateOptions {
  provider?: LLMProvider;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMClient {
  generateSummary(
    systemPrompt: string,
    userPrompt: string,
    options?: GenerateOptions
  ): Promise<LLMResponse>;
}

// Model constants for December 2025
export const CLAUDE_MODELS = {
  // Most intelligent, supports 'effort' parameter
  OPUS: 'claude-opus-4-5-20251124',
  // Best for agents/coding - $3/$15 per M tokens
  SONNET: 'claude-sonnet-4-5-20250929',
  // Fast & cheap - $1/$5 per M tokens
  HAIKU: 'claude-haiku-4-5-20251015'
} as const;

export const GEMINI_MODELS = {
  // Most capable - $2/$12 per M tokens
  PRO: 'gemini-3.0-pro',
  // Best price-performance - ~$0.15/$0.60 per M tokens
  FLASH: 'gemini-2.5-flash',
  // Fastest/cheapest - $0.10/$0.40 per M tokens
  FLASH_LITE: 'gemini-2.5-flash-lite'
} as const;

// Default model selection by level (optimized for cost/quality balance)
// - Leaf levels (high volume): Use cheapest models
// - Mid levels: Balance cost and quality
// - Top levels: Use best models for executive summaries
export const DEFAULT_MODEL_BY_LEVEL: Record<AnalysisLevel, { provider: LLMProvider; model: string }> = {
  // Gemini Flash-Lite for ads: $0.10/$0.40 per M tokens (cheapest, high volume)
  ad: { provider: 'gemini', model: GEMINI_MODELS.FLASH_LITE },
  // Gemini Flash-Lite for adsets: still high volume
  adset: { provider: 'gemini', model: GEMINI_MODELS.FLASH_LITE },
  // Claude Haiku for campaigns: $1/$5 per M tokens (good synthesis)
  campaign: { provider: 'claude', model: CLAUDE_MODELS.HAIKU },
  // Gemini 3 Pro for accounts: $2/$12 per M tokens (good aggregation)
  account: { provider: 'gemini', model: GEMINI_MODELS.PRO },
  // Claude Opus for cross-platform: best quality for executive summaries
  cross_platform: { provider: 'claude', model: CLAUDE_MODELS.OPUS },
  // Claude Opus for recommendations: agentic loop with tool calling
  recommendations: { provider: 'claude', model: CLAUDE_MODELS.OPUS }
};

// Token limits by level (10x for comprehensive analysis)
export const TOKEN_LIMITS_BY_LEVEL: Record<AnalysisLevel, number> = {
  ad: 5120,
  adset: 7680,
  campaign: 10240,
  account: 15360,
  cross_platform: 20480,
  recommendations: 20480  // Agentic loop uses same limit as cross-platform
};
