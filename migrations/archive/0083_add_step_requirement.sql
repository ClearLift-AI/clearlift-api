-- ============================================================================
-- MIGRATION 0083: Add step_requirement to conversion_goals
-- ============================================================================
-- Adds a structural prior for the probabilistic attribution bridge.
-- Each conversion goal can be REQUIRED (must-hit for high-confidence attribution),
-- OPTIONAL (nice-to-have), or AUTO (inferred from Bayesian priors over time).
-- ============================================================================

ALTER TABLE conversion_goals ADD COLUMN step_requirement TEXT DEFAULT 'auto'
  CHECK(step_requirement IN ('required', 'optional', 'auto'));

-- Macro conversions (is_conversion = 1) are required by default
UPDATE conversion_goals SET step_requirement = 'required' WHERE is_conversion = 1;

-- Macro conversion category goals are also required
UPDATE conversion_goals SET step_requirement = 'required'
  WHERE category = 'macro_conversion' AND step_requirement = 'auto';

-- Engagement goals are optional by default
UPDATE conversion_goals SET step_requirement = 'optional'
  WHERE category = 'engagement' AND step_requirement = 'auto';
