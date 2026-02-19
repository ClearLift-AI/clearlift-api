-- Extend onboarding_progress to track tag verification and goal creation
ALTER TABLE onboarding_progress ADD COLUMN has_verified_tag INTEGER DEFAULT 0;
ALTER TABLE onboarding_progress ADD COLUMN has_defined_goal INTEGER DEFAULT 0;
ALTER TABLE onboarding_progress ADD COLUMN verified_domains_count INTEGER DEFAULT 0;
ALTER TABLE onboarding_progress ADD COLUMN goals_count INTEGER DEFAULT 0;
