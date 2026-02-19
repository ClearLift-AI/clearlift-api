-- Migration: Add disabled_conversion_sources column to ai_optimization_settings
-- This allows users to disable specific conversion sources from being included
-- in analytics and AI analysis (default: none disabled = all sources shown)

ALTER TABLE ai_optimization_settings
ADD COLUMN disabled_conversion_sources TEXT DEFAULT '[]';

-- The column stores a JSON array of platform names that should be hidden
-- Example: '["stripe", "jobber"]' would hide those platforms from conversions view
-- Empty array means all connected platforms are shown (default behavior)
