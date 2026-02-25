-- Missing from consolidated schema: onboarding tables
-- These were in the old migrations/0004_onboarding.sql but missed during consolidation
-- Uses IF NOT EXISTS because staging/production already have these from old migrations

CREATE TABLE IF NOT EXISTS onboarding_progress (
  user_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  current_step TEXT NOT NULL DEFAULT 'welcome',
  steps_completed TEXT DEFAULT '[]',
  services_connected INTEGER DEFAULT 0,
  first_sync_completed BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  has_verified_tag INTEGER DEFAULT 0,
  has_defined_goal INTEGER DEFAULT 0,
  verified_domains_count INTEGER DEFAULT 0,
  goals_count INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_onboarding_progress_org ON onboarding_progress(organization_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_step ON onboarding_progress(current_step);

CREATE TABLE IF NOT EXISTS onboarding_steps (
  id TEXT PRIMARY KEY,
  step_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  order_index INTEGER NOT NULL,
  is_required BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
