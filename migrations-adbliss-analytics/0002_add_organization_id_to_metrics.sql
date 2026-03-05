-- Add indexes on organization_id for metrics tables
-- organization_id column already exists from 0001_schema.sql CREATE TABLE
-- These indexes improve query performance for D1 fallback path during
-- Architecture D transition (AE replaces D1 metrics at query time).

CREATE INDEX IF NOT EXISTS idx_hourly_metrics_org_id ON hourly_metrics(organization_id);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_org_id ON daily_metrics(organization_id);
CREATE INDEX IF NOT EXISTS idx_utm_performance_org_id ON utm_performance(organization_id);
