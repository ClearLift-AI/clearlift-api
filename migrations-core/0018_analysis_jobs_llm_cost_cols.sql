-- Add LLM cost tracking columns to analysis_jobs
ALTER TABLE analysis_jobs ADD COLUMN total_input_tokens INTEGER DEFAULT 0;
ALTER TABLE analysis_jobs ADD COLUMN total_output_tokens INTEGER DEFAULT 0;
ALTER TABLE analysis_jobs ADD COLUMN estimated_cost_cents REAL DEFAULT 0;
ALTER TABLE analysis_jobs ADD COLUMN llm_provider TEXT;
ALTER TABLE analysis_jobs ADD COLUMN llm_model TEXT;
