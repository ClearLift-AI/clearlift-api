-- ============================================================================
-- MIGRATION 0042: Add refund tracking to conversions table
-- ============================================================================
-- Enables accurate revenue reporting by tracking refunds on unified conversions.
-- Previously, charge.refunded webhooks were received but the conversion value
-- was never updated, causing permanent revenue overcounting.
-- ============================================================================

-- Track refund amount in cents (partial or full)
ALTER TABLE conversions ADD COLUMN refund_cents INTEGER DEFAULT 0;

-- Refund status: 'none', 'partial', 'full'
ALTER TABLE conversions ADD COLUMN refund_status TEXT DEFAULT 'none';

-- Timestamp of the most recent refund event
ALTER TABLE conversions ADD COLUMN refunded_at TEXT;

-- Index for querying refunded conversions (dashboard filters, audit)
CREATE INDEX IF NOT EXISTS idx_conv_refund_status
ON conversions(organization_id, refund_status)
WHERE refund_status != 'none';
