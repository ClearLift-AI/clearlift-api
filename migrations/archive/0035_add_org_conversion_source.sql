-- Add conversion_source to organizations table
-- This determines where the organization gets conversion data from:
--   'platform' = Use platform-reported conversions from Google/Meta/TikTok directly
--   'tag'      = Use ClearLift's first-party event tracking (most accurate)
--   'hybrid'   = Use both sources and reconcile differences

ALTER TABLE organizations ADD COLUMN conversion_source TEXT DEFAULT 'tag'
  CHECK(conversion_source IN ('platform', 'tag', 'hybrid'));

-- Index for querying by conversion source
CREATE INDEX IF NOT EXISTS idx_organizations_conversion_source
  ON organizations(conversion_source);
