-- Add run_frequency column (replaces growth_strategy conceptually)
ALTER TABLE ai_optimization_settings ADD COLUMN run_frequency TEXT NOT NULL DEFAULT 'weekly'
  CHECK(run_frequency IN ('weekly', 'daily', 'twice_daily'));

-- Migrate existing growth_strategy values to run_frequency
UPDATE ai_optimization_settings SET run_frequency = CASE
  WHEN growth_strategy = 'lean' THEN 'weekly'
  WHEN growth_strategy = 'bold' THEN 'twice_daily'
  ELSE 'daily'
END;

-- Add CAC ceiling (in cents, e.g. 5000 = $50 max CAC)
ALTER TABLE ai_optimization_settings ADD COLUMN max_cac_cents INTEGER;
