-- Add missing columns for D1 event sink (clearlift-events INSERT has 38 columns)
-- These columns were in the worker INSERT but missing from the 0003 CREATE TABLE.
-- Without this migration, every D1 write silently fails.
--
-- Must be applied BEFORE deploying clearlift-events feature/d1-sink branch.
-- Apply with: npx wrangler d1 migrations apply ANALYTICS_DB --remote
--             npx wrangler d1 migrations apply ANALYTICS_DB --remote --env staging

-- Navigation / session stitching (used by ConversionLinking external click query)
ALTER TABLE adbliss_events ADD COLUMN navigation_type TEXT;
ALTER TABLE adbliss_events ADD COLUMN previous_anonymous_id TEXT;
ALTER TABLE adbliss_events ADD COLUMN previous_session_id TEXT;

-- Page context (used by ClickExtraction query)
ALTER TABLE adbliss_events ADD COLUMN page_hostname TEXT;

-- Index for ConversionLinking external click query:
--   WHERE navigation_type = 'external'
CREATE INDEX IF NOT EXISTS idx_adbliss_events_org_navtype
  ON adbliss_events (org_tag, navigation_type)
  WHERE navigation_type IS NOT NULL;
