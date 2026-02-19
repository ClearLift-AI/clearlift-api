-- Migration: Add unified_event_type to conversions and goal_conversions
-- Enables cross-connector reporting with normalized event types

-- Add unified_event_type to conversions table
ALTER TABLE conversions ADD COLUMN unified_event_type TEXT;

-- Add unified_event_type to goal_conversions table
ALTER TABLE goal_conversions ADD COLUMN unified_event_type TEXT;

-- Create index for querying by unified event type
CREATE INDEX IF NOT EXISTS idx_conv_unified_type
ON conversions(organization_id, unified_event_type);

CREATE INDEX IF NOT EXISTS idx_goal_conv_unified_type
ON goal_conversions(organization_id, unified_event_type);

-- Add connector field if not exists (some webhook inserts use this)
-- Note: conversion_source serves similar purpose, but connector is more specific
ALTER TABLE conversions ADD COLUMN connector TEXT;
ALTER TABLE conversions ADD COLUMN event_type TEXT;

-- Index for connector-based queries
CREATE INDEX IF NOT EXISTS idx_conv_connector
ON conversions(organization_id, connector);
