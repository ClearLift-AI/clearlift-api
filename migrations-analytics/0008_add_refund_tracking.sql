-- Add refund tracking to revenue source tables
-- Enables accurate net revenue calculations

-- Add refund columns to stripe_charges
ALTER TABLE stripe_charges ADD COLUMN refund_cents INTEGER DEFAULT 0;
ALTER TABLE stripe_charges ADD COLUMN refund_at TEXT;
ALTER TABLE stripe_charges ADD COLUMN refund_status TEXT; -- 'none', 'partial', 'full'

-- Add refund columns to shopify_orders (if table exists)
-- Note: shopify_orders table is created in 0006_shopify_jobber.sql
ALTER TABLE shopify_orders ADD COLUMN refund_cents INTEGER DEFAULT 0;
ALTER TABLE shopify_orders ADD COLUMN refund_at TEXT;
ALTER TABLE shopify_orders ADD COLUMN refund_status TEXT; -- 'none', 'partial', 'full'

-- Create index for efficient refund queries
CREATE INDEX IF NOT EXISTS idx_sc_refund_status ON stripe_charges(organization_id, refund_status);
CREATE INDEX IF NOT EXISTS idx_so_refund_status ON shopify_orders(organization_id, refund_status);
