/**
 * Analysis Services
 *
 * AI analysis engine for ad performance insights.
 * v2 (Feb 2026): Math-first portfolio analysis + agentic recommendations.
 */

// LLM Layer (model constants + types)
export * from './llm-provider';

// Data Layer
export * from './entity-tree';
export * from './metrics-fetcher';

// Orchestration
export * from './job-manager';

// Read-only query helpers
export * from './analysis-queries';

// Agentic tools (used by analysis-workflow.ts)
export * from './recommendation-tools';
export * from './exploration-tools';
