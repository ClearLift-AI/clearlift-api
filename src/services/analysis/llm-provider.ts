/**
 * LLM Provider Types and Constants
 *
 * Model constants and shared types for the AI analysis engine.
 */

export type LLMProvider = 'claude' | 'gemini';

export type AnalysisLevel = 'ad' | 'adset' | 'campaign' | 'account' | 'cross_platform' | 'recommendations';

// Model constants
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
  // Fast & capable, 1000 RPM - for agentic recommendations
  FLASH: 'gemini-3-flash-preview',
  // Legacy fallback
  FLASH_LITE: 'gemini-2.5-flash-lite'
} as const;

/**
 * Per-million-token pricing (in USD cents) for cost estimation.
 * Rates as of Feb 2026. Update when pricing changes.
 */
interface TokenRate {
  inputPerMillion: number;   // cents per 1M input tokens
  outputPerMillion: number;  // cents per 1M output tokens
}

const PRICING: Record<string, TokenRate> = {
  // Claude models
  [CLAUDE_MODELS.OPUS]:   { inputPerMillion: 500,  outputPerMillion: 2500 },  // $5/$25
  [CLAUDE_MODELS.SONNET]: { inputPerMillion: 300,  outputPerMillion: 1500 },  // $3/$15
  [CLAUDE_MODELS.HAIKU]:  { inputPerMillion: 100,  outputPerMillion: 500  },  // $1/$5
  // Gemini models
  [GEMINI_MODELS.PRO]:       { inputPerMillion: 125,  outputPerMillion: 500  },  // $1.25/$5
  [GEMINI_MODELS.FLASH]:     { inputPerMillion: 7.5,  outputPerMillion: 30   },  // $0.075/$0.30
  [GEMINI_MODELS.FLASH_LITE]:{ inputPerMillion: 7.5,  outputPerMillion: 30   },  // ~same as flash
};

// Fallback rates by provider (use cheapest model as default)
const FALLBACK_RATES: Record<LLMProvider, TokenRate> = {
  claude: { inputPerMillion: 100, outputPerMillion: 500 },   // Haiku rates
  gemini: { inputPerMillion: 7.5, outputPerMillion: 30 },    // Flash rates
};

/**
 * Calculate estimated cost in cents from token usage.
 *
 * @param provider - 'claude' or 'gemini'
 * @param model - specific model ID string
 * @param inputTokens - total input tokens consumed
 * @param outputTokens - total output tokens consumed
 * @returns estimated cost in cents (integer, rounded up)
 */
export function calculateCostCents(
  provider: LLMProvider,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rates = PRICING[model] || FALLBACK_RATES[provider] || FALLBACK_RATES.gemini;
  const inputCost = (inputTokens / 1_000_000) * rates.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * rates.outputPerMillion;
  return Math.ceil(inputCost + outputCost);
}
