-- Migration: Add rate_limits table
-- Created: 2025-11-24
--
-- This table stores rate limiting state for the API
-- Used by src/middleware/rateLimit.ts for distributed rate limiting
--
-- Production Impact: SAFE - Table already exists in production (created by middleware)
-- Fresh installs will create the table via this migration instead of inline CREATE

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  last_request TEXT NOT NULL
);

-- Index for cleanup queries (removing expired entries)
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_end ON rate_limits(window_end);
