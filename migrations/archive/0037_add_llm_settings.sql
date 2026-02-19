-- Add LLM provider settings to ai_optimization_settings
-- These allow users to configure which AI models to use for analysis
-- Settings are unified with the rest of the AI/Matrix settings

-- Default provider: 'auto' uses cost-optimized selection per level
-- 'claude' or 'gemini' forces that provider for all levels
ALTER TABLE ai_optimization_settings ADD COLUMN llm_default_provider TEXT DEFAULT 'auto';

-- Model preferences when using specific providers
-- Claude: 'opus' (best), 'sonnet' (balanced), 'haiku' (fast/cheap)
ALTER TABLE ai_optimization_settings ADD COLUMN llm_claude_model TEXT DEFAULT 'haiku';

-- Gemini: 'pro' (best), 'flash' (balanced), 'flash_lite' (fast/cheap)
ALTER TABLE ai_optimization_settings ADD COLUMN llm_gemini_model TEXT DEFAULT 'flash';

-- Max recommendations per analysis run (default 3)
ALTER TABLE ai_optimization_settings ADD COLUMN llm_max_recommendations INTEGER DEFAULT 3;

-- Enable/disable exploration tools in agentic loop (default enabled)
ALTER TABLE ai_optimization_settings ADD COLUMN llm_enable_exploration INTEGER DEFAULT 1;
