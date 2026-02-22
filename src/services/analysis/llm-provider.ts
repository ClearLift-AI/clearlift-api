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
