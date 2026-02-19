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
  // Most intelligent - $5/$25 per M tokens
  OPUS: 'claude-opus-4-5-20251101',
  // Best for agents/coding - $3/$15 per M tokens
  SONNET: 'claude-sonnet-4-5-20250929',
  // Fast & cheap - $1/$5 per M tokens
  HAIKU: 'claude-haiku-4-5-20251001'
} as const;

export const GEMINI_MODELS = {
  // Best quality, 25 RPM - for executive summaries only
  PRO: 'gemini-3-pro-preview',
  // Fast & capable, 1000 RPM - for entity processing
  FLASH: 'gemini-3-flash-preview',
  // Legacy fallback
  FLASH_LITE: 'gemini-2.5-flash-lite'
} as const;

// Default model selection by level (optimized for cost/quality balance)
// - Entity levels: Gemini 3 Flash (1000 RPM, fast & capable)
// - Executive summary: Gemini 3 Pro (25 RPM, best quality)
// - Recommendations: Claude Opus (agentic tool calling)
export const DEFAULT_MODEL_BY_LEVEL: Record<AnalysisLevel, { provider: LLMProvider; model: string }> = {
  // Gemini 3 Flash for entity processing (1000 RPM)
  ad: { provider: 'gemini', model: GEMINI_MODELS.FLASH },
  adset: { provider: 'gemini', model: GEMINI_MODELS.FLASH },
  campaign: { provider: 'gemini', model: GEMINI_MODELS.FLASH },
  account: { provider: 'gemini', model: GEMINI_MODELS.FLASH },
  // Gemini 3 Pro for executive summary (25 RPM, single call)
  cross_platform: { provider: 'gemini', model: GEMINI_MODELS.PRO },
  // Gemini 3 Flash for recommendations: agentic loop with tool calling (cost-optimized)
  recommendations: { provider: 'gemini', model: GEMINI_MODELS.FLASH }
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
