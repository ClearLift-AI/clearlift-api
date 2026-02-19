-- Add updated_at column to ad_metrics for tracking when rows are overwritten by syncs
ALTER TABLE ad_metrics ADD COLUMN updated_at TEXT;

-- Backfill existing rows with their created_at value
UPDATE ad_metrics SET updated_at = created_at WHERE updated_at IS NULL;
