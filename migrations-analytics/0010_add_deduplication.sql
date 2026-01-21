-- Add deduplication key to conversions table
-- Prevents double-counting conversions across sources using email hash + date + source

-- Add dedup_key column to conversions
ALTER TABLE conversions ADD COLUMN dedup_key TEXT;

-- Create index for efficient dedup lookups
CREATE INDEX IF NOT EXISTS idx_conv_dedup ON conversions(organization_id, dedup_key);

-- Create unique constraint to prevent duplicates
-- Note: SQLite doesn't support adding unique constraints after table creation,
-- so we use a unique index instead
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_dedup_unique ON conversions(organization_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- Also add dedup tracking to stripe_charges and shopify_orders
-- for pre-aggregation dedup checks
ALTER TABLE stripe_charges ADD COLUMN dedup_key TEXT;
ALTER TABLE shopify_orders ADD COLUMN dedup_key TEXT;

CREATE INDEX IF NOT EXISTS idx_sc_dedup ON stripe_charges(organization_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_so_dedup ON shopify_orders(organization_id, dedup_key);
