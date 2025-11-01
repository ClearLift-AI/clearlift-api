-- ============================================================================
-- D1 TEST DATA FOR CLEARLIFT DASHBOARD
-- ============================================================================
-- Purpose: Create test user, platform connections, and AI settings for UI/UX testing
-- Organization: test-org-001 (already exists)
-- User: demo@clearlift.ai
-- Date Range: Last 30 days
-- ============================================================================

-- ============================================================================
-- 1. TEST USER
-- ============================================================================
-- Password: Demo123! (bcrypt hash for testing)
INSERT OR IGNORE INTO users (id, email, password_hash, name, is_verified, created_at)
VALUES (
  'user-demo-001',
  'demo@clearlift.ai',
  '$2b$10$K9Y4Zq8Zq8Zq8Zq8Zq8Z.O.K9Y4Zq8Zq8Zq8Zq8Zq8Zq8Zq8Zq8Zq', -- Demo123!
  'Demo User',
  1,
  datetime('now', '-90 days')
);

-- ============================================================================
-- 2. ORGANIZATION MEMBERSHIP
-- ============================================================================
-- Add demo user to test-org-001
INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, joined_at)
VALUES (
  'test-org-001',
  'user-demo-001',
  'owner',
  datetime('now', '-90 days')
);

-- ============================================================================
-- 3. ACTIVE SESSION
-- ============================================================================
-- Create an active session for easy login
DELETE FROM sessions WHERE user_id = 'user-demo-001';

INSERT INTO sessions (id, user_id, session_token_hash, expires_at, created_at, last_used_at)
VALUES (
  'session-demo-001',
  'user-demo-001',
  '$2b$10$DemoSessionHashForTestingPurposes123456789', -- test-session-token
  datetime('now', '+30 days'),
  datetime('now', '-1 hour'),
  datetime('now', '-5 minutes')
);

-- ============================================================================
-- 4. PLATFORM CONNECTIONS
-- ============================================================================

-- Facebook Ads Connection
INSERT OR REPLACE INTO platform_connections (
  id,
  organization_id,
  platform,
  account_id,
  account_name,
  connected_by,
  connected_at,
  last_synced_at,
  sync_status,
  sync_error,
  is_active,
  settings
) VALUES (
  'test-org-001-facebook-123456789',
  'test-org-001',
  'facebook',
  'act_123456789',
  'Demo Facebook Ad Account',
  'user-demo-001',
  datetime('now', '-60 days'),
  datetime('now', '-2 hours'),
  'completed',
  NULL,
  1,
  '{}'
);

-- Google Ads Connection
INSERT OR REPLACE INTO platform_connections (
  id,
  organization_id,
  platform,
  account_id,
  account_name,
  connected_by,
  connected_at,
  last_synced_at,
  sync_status,
  sync_error,
  is_active,
  settings
) VALUES (
  'test-org-001-google-987654321',
  'test-org-001',
  'google',
  '987-654-3210',
  'Demo Google Ads Account',
  'user-demo-001',
  datetime('now', '-60 days'),
  datetime('now', '-2 hours'),
  'completed',
  NULL,
  1,
  '{}'
);

-- Stripe Connection
INSERT OR REPLACE INTO platform_connections (
  id,
  organization_id,
  platform,
  account_id,
  account_name,
  connected_by,
  connected_at,
  last_synced_at,
  sync_status,
  sync_error,
  is_active,
  settings
) VALUES (
  'test-org-001-stripe-acct_test123',
  'test-org-001',
  'stripe',
  'acct_test123',
  'Demo Stripe Account',
  'user-demo-001',
  datetime('now', '-60 days'),
  datetime('now', '-3 hours'),
  'completed',
  NULL,
  1,
  '{}'
);

-- ============================================================================
-- 5. AI OPTIMIZATION SETTINGS
-- ============================================================================
INSERT OR REPLACE INTO ai_optimization_settings (
  org_id,
  growth_strategy,
  budget_optimization,
  ai_control,
  daily_cap_cents,
  monthly_cap_cents,
  pause_threshold_percent,
  conversion_source,
  last_recommendation_at,
  created_at,
  updated_at
) VALUES (
  'test-org-001',
  'balanced',
  'aggressive',
  'copilot',
  2000000, -- $20,000 daily cap
  5000000, -- $50,000 monthly cap
  15, -- Pause at 15% over budget
  'tag', -- Use clickstream tracking for most accurate CAC
  datetime('now', '-23 hours'), -- Last recommendation 23 hours ago (will trigger soon)
  datetime('now', '-30 days'),
  datetime('now', '-1 day')
);

-- ============================================================================
-- 6. AI DECISIONS (PENDING RECOMMENDATIONS)
-- ============================================================================

-- Recommendation 1: Increase budget on high-performing campaign
INSERT OR REPLACE INTO ai_decisions (
  decision_id,
  org_id,
  recommended_action,
  parameters,
  reason,
  impact,
  confidence,
  status,
  expires_at,
  created_at,
  reviewed_at,
  applied_at
) VALUES (
  'decision-001-increase-budget',
  'test-org-001',
  'increase_budget',
  '{"campaign_id": "fb_camp_summer_sale", "campaign_name": "Summer Sale", "current_budget_cents": 15000, "recommended_budget_cents": 22500, "platform": "facebook", "increase_percent": 50}',
  'Campaign "Summer Sale" has 1.2% CTR and $0.45 CPC, 35% below account average CPA with strong ROAS of 4.2x',
  -18, -- 18% CaC reduction expected
  'high',
  'pending',
  datetime('now', '+6 days'),
  datetime('now', '-2 days'),
  NULL,
  NULL
);

-- Recommendation 2: Pause underperforming campaign
INSERT OR REPLACE INTO ai_decisions (
  decision_id,
  org_id,
  recommended_action,
  parameters,
  reason,
  impact,
  confidence,
  status,
  expires_at,
  created_at,
  reviewed_at,
  applied_at
) VALUES (
  'decision-002-pause-campaign',
  'test-org-001',
  'pause_campaign',
  '{"campaign_id": "fb_camp_brand_awareness", "campaign_name": "Brand Awareness - General", "current_cpa_cents": 8700, "account_avg_cpa_cents": 5000, "platform": "facebook", "days_analyzed": 14}',
  'Campaign "Brand Awareness - General" has CPA of $87, 74% higher than account average with declining performance trend',
  -12, -- 12% CaC reduction by eliminating waste
  'high',
  'pending',
  datetime('now', '+6 days'),
  datetime('now', '-1 day'),
  NULL,
  NULL
);

-- Recommendation 3: Switch to automated bidding
INSERT OR REPLACE INTO ai_decisions (
  decision_id,
  org_id,
  recommended_action,
  parameters,
  reason,
  impact,
  confidence,
  status,
  expires_at,
  created_at,
  reviewed_at,
  applied_at
) VALUES (
  'decision-003-adjust-bid-strategy',
  'test-org-001',
  'adjust_bid_strategy',
  '{"campaign_id": "goog_camp_search_brand", "campaign_name": "Search - Brand Keywords", "current_strategy": "manual_cpc", "recommended_strategy": "target_cpa", "target_cpa_cents": 4500, "platform": "google"}',
  'Campaign "Search - Brand Keywords" using manual CPC shows 28% bid volatility; automated Target CPA could stabilize performance and reduce waste',
  -15, -- 15% CaC reduction from optimization
  'medium',
  'pending',
  datetime('now', '+6 days'),
  datetime('now', '-12 hours'),
  NULL,
  NULL
);

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- User: demo@clearlift.ai (password: Demo123!)
-- Session Token: test-session-token
-- Organization: test-org-001 (Test Organization)
-- Org Tag: test-org
-- Connections: Facebook, Google, Stripe (all synced in last 3 hours)
-- AI Settings: Balanced growth, Aggressive optimization, Copilot mode, Tag conversions
-- AI Decisions: 3 pending recommendations
-- ============================================================================
