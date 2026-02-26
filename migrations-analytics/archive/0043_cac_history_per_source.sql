-- Add per-source conversion breakdown to cac_history
ALTER TABLE cac_history ADD COLUMN conversions_stripe INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN conversions_shopify INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN conversions_jobber INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN conversions_tag INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN revenue_stripe_cents INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN revenue_shopify_cents INTEGER DEFAULT 0;
ALTER TABLE cac_history ADD COLUMN revenue_jobber_cents INTEGER DEFAULT 0;
