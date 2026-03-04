-- Add organization_id to metrics tables that only had org_tag
-- organization_id (UUID) is the canonical org identifier per project convention

-- hourly_metrics
ALTER TABLE hourly_metrics ADD COLUMN organization_id TEXT;
CREATE INDEX idx_hourly_metrics_org_id ON hourly_metrics(organization_id);

-- daily_metrics
ALTER TABLE daily_metrics ADD COLUMN organization_id TEXT;
CREATE INDEX idx_daily_metrics_org_id ON daily_metrics(organization_id);

-- utm_performance
ALTER TABLE utm_performance ADD COLUMN organization_id TEXT;
CREATE INDEX idx_utm_performance_org_id ON utm_performance(organization_id);

-- Backfill organization_id from org_tag_mappings (run after migration)
-- This is a data migration that resolves org_tag -> organization_id
-- NOTE: These tables are being deprecated by Architecture D (AE replaces D1 metrics).
-- The backfill ensures the D1 fallback path works during the transition period.
