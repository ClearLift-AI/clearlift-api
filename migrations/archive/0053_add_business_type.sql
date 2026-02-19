-- Add business_type to ai_optimization_settings
-- This determines how conversions and revenue are calculated in Real-Time analytics:
-- - 'ecommerce': Conversions = Stripe charges, Revenue = Stripe revenue
-- - 'lead_gen': Conversions = Tag goal events, Revenue hidden (or pipeline value)
-- - 'saas': Conversions = New subscriptions, Revenue = MRR from Stripe

ALTER TABLE ai_optimization_settings
ADD COLUMN business_type TEXT DEFAULT 'lead_gen' CHECK(business_type IN ('ecommerce', 'lead_gen', 'saas'));

-- Add an index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_ai_optimization_settings_business_type
ON ai_optimization_settings(org_id, business_type);
