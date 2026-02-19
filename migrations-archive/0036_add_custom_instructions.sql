-- Add custom_instructions field to ai_optimization_settings
-- This allows users to provide custom context/instructions that are injected
-- into the AI agent's system prompt when analyzing their advertising data.

ALTER TABLE ai_optimization_settings
  ADD COLUMN custom_instructions TEXT;
