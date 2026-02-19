-- Add billing_reason for SaaS conversion tracking
-- Distinguishes new subscriptions (subscription_create) from renewals (subscription_cycle)
-- Only subscription_create should count as a "conversion" for SaaS businesses

-- Add billing_reason column to stripe_charges
-- Values: 'subscription_create', 'subscription_cycle', 'subscription_update', 'manual', null (one-time)
ALTER TABLE stripe_charges ADD COLUMN billing_reason TEXT;

-- Index for filtering by billing_reason (important for SaaS conversion queries)
CREATE INDEX IF NOT EXISTS idx_sc_billing_reason ON stripe_charges(organization_id, billing_reason);

-- Create a partial index for new subscription conversions (SaaS mode)
CREATE INDEX IF NOT EXISTS idx_sc_new_subscriptions ON stripe_charges(organization_id, stripe_created_at)
  WHERE billing_reason = 'subscription_create';
