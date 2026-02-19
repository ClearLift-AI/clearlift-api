-- Migration: Add needs_reauth flag to platform_connections
-- Purpose: Track connections with invalid OAuth tokens that need user re-authentication
-- This prevents continuous failing sync jobs and enables dashboard warnings

-- Add needs_reauth flag (defaults to false)
ALTER TABLE platform_connections ADD COLUMN needs_reauth BOOLEAN DEFAULT FALSE;

-- Add reauth_reason to explain why reauth is needed
ALTER TABLE platform_connections ADD COLUMN reauth_reason TEXT;

-- Add reauth_detected_at to track when the issue was detected
ALTER TABLE platform_connections ADD COLUMN reauth_detected_at DATETIME;

-- Add consecutive_auth_failures to track how many times auth has failed
-- This allows us to only mark needs_reauth after multiple failures (avoid false positives)
ALTER TABLE platform_connections ADD COLUMN consecutive_auth_failures INTEGER DEFAULT 0;

-- Index for efficient queries on connections needing reauth
CREATE INDEX IF NOT EXISTS idx_platform_connections_needs_reauth
ON platform_connections(organization_id, needs_reauth)
WHERE needs_reauth = TRUE;
