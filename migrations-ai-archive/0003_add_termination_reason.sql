-- Add stopped_reason and termination_reason columns to analysis_jobs
-- These track why the AI analysis loop ended and any early termination reasoning

ALTER TABLE analysis_jobs ADD COLUMN stopped_reason TEXT;
-- Values: 'max_recommendations', 'no_tool_calls', 'max_iterations', 'early_termination'

ALTER TABLE analysis_jobs ADD COLUMN termination_reason TEXT;
-- Human-readable reason when agent calls terminate_analysis tool
