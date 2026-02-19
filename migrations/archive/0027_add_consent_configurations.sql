-- Migration: Add consent_configurations table
-- Created: 2025-11-24
--
-- This table stores per-organization consent banner configuration
-- Used by clearlift-events worker to serve consent config to the tracking tag
--
-- Production Impact: SAFE - Table already exists in production (created manually)
-- Fresh installs will create the table via this migration

CREATE TABLE IF NOT EXISTS consent_configurations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_tag TEXT NOT NULL UNIQUE,

  -- Consent mode settings
  consent_mode TEXT NOT NULL DEFAULT 'auto',
  consent_required BOOLEAN DEFAULT 1,
  privacy_policy_url TEXT,

  -- Banner display settings
  banner_enabled BOOLEAN DEFAULT 1,
  banner_position TEXT DEFAULT 'bottom',
  banner_style TEXT DEFAULT 'minimal',
  banner_text TEXT,

  -- Button labels
  button_accept TEXT DEFAULT 'Accept',
  button_reject TEXT DEFAULT 'Reject',
  button_customize TEXT DEFAULT 'Customize',

  -- Styling
  primary_color TEXT DEFAULT '#667eea',

  -- Cookie categories
  enable_analytics BOOLEAN DEFAULT 1,
  enable_marketing BOOLEAN DEFAULT 0,
  enable_preferences BOOLEAN DEFAULT 1,

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (org_tag) REFERENCES org_tag_mappings(short_tag)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_consent_config_org_tag ON consent_configurations(org_tag);
