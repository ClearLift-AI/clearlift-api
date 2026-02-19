-- Goal Hierarchy System
-- Enables automatic value calculation for upstream goals based on conversion probability
-- Supports funnel relationships (checkout → purchase) and correlations (newsletter → eventual purchase)

-- =============================================================================
-- 1. Add category and value computation columns to conversion_goals
-- =============================================================================

-- Goal category: determines how the goal fits in the conversion funnel
-- 'macro_conversion': Primary business outcomes (purchase, subscription, lead)
-- 'micro_conversion': Funnel steps (checkout page, add to cart, pricing page)
-- 'engagement': Soft goals (newsletter, account creation, content download)
ALTER TABLE conversion_goals ADD COLUMN category TEXT DEFAULT 'micro_conversion';

-- Value computation method
-- 'explicit': User-defined fixed value
-- 'expected_value': Historical conversion rate × downstream goal value
-- 'bayesian': Prior + observed data with confidence intervals
-- 'funnel_position': Decay based on funnel distance
ALTER TABLE conversion_goals ADD COLUMN value_method TEXT DEFAULT 'explicit';

-- Whether to automatically recompute value based on new data
ALTER TABLE conversion_goals ADD COLUMN auto_compute_value INTEGER DEFAULT 0;

-- Computed value (cached result of automatic calculation)
ALTER TABLE conversion_goals ADD COLUMN computed_value_cents INTEGER;

-- Confidence interval for computed values (95% CI)
ALTER TABLE conversion_goals ADD COLUMN computed_value_lower_cents INTEGER;
ALTER TABLE conversion_goals ADD COLUMN computed_value_upper_cents INTEGER;

-- When the value was last computed
ALTER TABLE conversion_goals ADD COLUMN value_computed_at TEXT;

-- =============================================================================
-- 2. Goal Relationships Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS goal_relationships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  upstream_goal_id TEXT NOT NULL,    -- The earlier goal (e.g., checkout page view)
  downstream_goal_id TEXT NOT NULL,  -- The later goal (e.g., purchase)
  relationship_type TEXT NOT NULL CHECK(relationship_type IN ('funnel', 'correlated')),
  -- 'funnel': Direct path (checkout → purchase)
  -- 'correlated': Statistical relationship (newsletter → eventual purchase)
  funnel_position INTEGER,           -- Position in funnel (1 = closest to conversion)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (downstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  UNIQUE(organization_id, upstream_goal_id, downstream_goal_id)
);

CREATE INDEX IF NOT EXISTS idx_goal_relationships_org
  ON goal_relationships(organization_id);
CREATE INDEX IF NOT EXISTS idx_goal_relationships_downstream
  ON goal_relationships(organization_id, downstream_goal_id);

-- =============================================================================
-- 3. Goal Conversion Statistics Table
-- Stores historical conversion rates between goals
-- =============================================================================

CREATE TABLE IF NOT EXISTS goal_conversion_stats (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  upstream_goal_id TEXT NOT NULL,
  downstream_goal_id TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'weekly', 'monthly', 'all_time')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,

  -- Counts
  upstream_count INTEGER DEFAULT 0,      -- How many times upstream goal triggered
  downstream_count INTEGER DEFAULT 0,    -- How many times downstream goal triggered
  converted_count INTEGER DEFAULT 0,     -- How many upstream led to downstream

  -- Rates
  conversion_rate REAL,                  -- converted_count / upstream_count
  avg_time_to_convert_hours REAL,        -- Average time between goals
  median_time_to_convert_hours REAL,

  -- For Bayesian estimation
  prior_alpha REAL DEFAULT 1.0,          -- Beta distribution alpha (successes + prior)
  prior_beta REAL DEFAULT 1.0,           -- Beta distribution beta (failures + prior)

  computed_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (downstream_goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE,
  UNIQUE(organization_id, upstream_goal_id, downstream_goal_id, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_goal_conversion_stats_lookup
  ON goal_conversion_stats(organization_id, upstream_goal_id, downstream_goal_id, period_type);

-- =============================================================================
-- 4. Goal Value History Table
-- Tracks computed values over time for trend analysis
-- =============================================================================

CREATE TABLE IF NOT EXISTS goal_value_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  value_method TEXT NOT NULL,
  computed_value_cents INTEGER NOT NULL,
  confidence_lower_cents INTEGER,
  confidence_upper_cents INTEGER,
  sample_size INTEGER,
  computation_details TEXT,  -- JSON with calculation breakdown
  computed_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES conversion_goals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goal_value_history_lookup
  ON goal_value_history(organization_id, goal_id, computed_at DESC);

-- =============================================================================
-- 5. Default Goal Templates Table
-- Pre-configured goals for different business types
-- =============================================================================

CREATE TABLE IF NOT EXISTS goal_templates (
  id TEXT PRIMARY KEY,
  business_type TEXT NOT NULL,  -- 'ecommerce', 'saas', 'lead_gen', 'content', 'marketplace'
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,       -- 'macro_conversion', 'micro_conversion', 'engagement'
  goal_type TEXT NOT NULL,      -- 'revenue_source', 'tag_event', 'page_view'
  trigger_config TEXT,          -- JSON configuration
  default_value_cents INTEGER,
  value_method TEXT DEFAULT 'explicit',
  suggested_funnel_position INTEGER,
  icon TEXT,
  color TEXT,
  display_order INTEGER DEFAULT 0,
  is_recommended INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Insert common goal templates
INSERT INTO goal_templates (id, business_type, name, slug, description, category, goal_type, trigger_config, default_value_cents, value_method, suggested_funnel_position, icon, color, display_order, is_recommended) VALUES
-- E-commerce goals
('tpl_ecom_purchase', 'ecommerce', 'Purchase', 'purchase', 'Completed purchase', 'macro_conversion', 'revenue_source', '{"revenue_sources": ["stripe", "shopify"]}', NULL, 'explicit', NULL, 'shopping-cart', '#10B981', 0, 1),
('tpl_ecom_checkout', 'ecommerce', 'Checkout Started', 'checkout-started', 'Reached checkout page', 'micro_conversion', 'page_view', '{"page_pattern": "/checkout*"}', NULL, 'expected_value', 1, 'credit-card', '#3B82F6', 1, 1),
('tpl_ecom_cart', 'ecommerce', 'Add to Cart', 'add-to-cart', 'Added item to cart', 'micro_conversion', 'tag_event', '{"event_type": "add_to_cart"}', NULL, 'expected_value', 2, 'shopping-bag', '#8B5CF6', 2, 1),
('tpl_ecom_product', 'ecommerce', 'Product View', 'product-view', 'Viewed product page', 'micro_conversion', 'page_view', '{"page_pattern": "/products/*"}', NULL, 'expected_value', 3, 'eye', '#6366F1', 3, 0),
('tpl_ecom_newsletter', 'ecommerce', 'Newsletter Signup', 'newsletter', 'Subscribed to newsletter', 'engagement', 'tag_event', '{"event_type": "newsletter_signup"}', 1000, 'expected_value', NULL, 'mail', '#EC4899', 4, 1),

-- SaaS goals
('tpl_saas_subscription', 'saas', 'Paid Subscription', 'subscription', 'Started paid subscription', 'macro_conversion', 'revenue_source', '{"revenue_sources": ["stripe"]}', NULL, 'explicit', NULL, 'credit-card', '#10B981', 0, 1),
('tpl_saas_trial', 'saas', 'Trial Started', 'trial-started', 'Started free trial', 'micro_conversion', 'tag_event', '{"event_type": "signup", "goal_id": "trial"}', NULL, 'expected_value', 1, 'play', '#3B82F6', 1, 1),
('tpl_saas_pricing', 'saas', 'Pricing Page View', 'pricing-view', 'Viewed pricing page', 'micro_conversion', 'page_view', '{"page_pattern": "/pricing*"}', NULL, 'expected_value', 2, 'dollar-sign', '#8B5CF6', 2, 1),
('tpl_saas_demo', 'saas', 'Demo Request', 'demo-request', 'Requested product demo', 'micro_conversion', 'tag_event', '{"event_type": "form_submit", "goal_id": "demo"}', 5000, 'explicit', 1, 'video', '#F59E0B', 3, 1),
('tpl_saas_newsletter', 'saas', 'Newsletter Signup', 'newsletter', 'Subscribed to newsletter', 'engagement', 'tag_event', '{"event_type": "newsletter_signup"}', 500, 'expected_value', NULL, 'mail', '#EC4899', 4, 0),

-- Lead gen goals
('tpl_lead_form', 'lead_gen', 'Lead Form Submit', 'lead-form', 'Submitted contact form', 'macro_conversion', 'tag_event', '{"event_type": "form_submit"}', 5000, 'explicit', NULL, 'user-plus', '#10B981', 0, 1),
('tpl_lead_call', 'lead_gen', 'Phone Call', 'phone-call', 'Made phone call', 'macro_conversion', 'tag_event', '{"event_type": "call"}', 10000, 'explicit', NULL, 'phone', '#3B82F6', 1, 1),
('tpl_lead_quote', 'lead_gen', 'Quote Request', 'quote-request', 'Requested a quote', 'micro_conversion', 'tag_event', '{"event_type": "form_submit", "goal_id": "quote"}', 2500, 'expected_value', 1, 'file-text', '#8B5CF6', 2, 1),
('tpl_lead_contact', 'lead_gen', 'Contact Page View', 'contact-view', 'Viewed contact page', 'micro_conversion', 'page_view', '{"page_pattern": "/contact*"}', NULL, 'expected_value', 2, 'map-pin', '#6366F1', 3, 0),
('tpl_lead_newsletter', 'lead_gen', 'Newsletter Signup', 'newsletter', 'Subscribed to newsletter', 'engagement', 'tag_event', '{"event_type": "newsletter_signup"}', 1000, 'expected_value', NULL, 'mail', '#EC4899', 4, 1),

-- Content/media goals
('tpl_content_subscribe', 'content', 'Subscription', 'subscription', 'Paid content subscription', 'macro_conversion', 'revenue_source', '{"revenue_sources": ["stripe"]}', NULL, 'explicit', NULL, 'credit-card', '#10B981', 0, 1),
('tpl_content_signup', 'content', 'Account Created', 'account-created', 'Created free account', 'micro_conversion', 'tag_event', '{"event_type": "signup"}', NULL, 'expected_value', 1, 'user-plus', '#3B82F6', 1, 1),
('tpl_content_newsletter', 'content', 'Newsletter Signup', 'newsletter', 'Subscribed to newsletter', 'engagement', 'tag_event', '{"event_type": "newsletter_signup"}', 200, 'expected_value', NULL, 'mail', '#EC4899', 2, 1),
('tpl_content_download', 'content', 'Content Download', 'content-download', 'Downloaded gated content', 'engagement', 'tag_event', '{"event_type": "download"}', 500, 'explicit', NULL, 'download', '#8B5CF6', 3, 1);

CREATE INDEX IF NOT EXISTS idx_goal_templates_business_type
  ON goal_templates(business_type, display_order);
