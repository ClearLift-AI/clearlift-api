-- Purge Test Data Script for ClearLift D1 Database
-- This script removes all test users and organizations while preserving database structure
-- Run with: npx wrangler d1 execute ClearLiftDash-D1 --remote --file=scripts/purge-test-data.sql

-- Step 1: Delete sync-related data
DELETE FROM sync_jobs;
DELETE FROM connector_filter_rules;
DELETE FROM connector_configs;

-- Step 2: Delete platform connections
DELETE FROM platform_connections;

-- Step 3: Delete OAuth states (temporary auth states)
DELETE FROM oauth_states;

-- Step 4: Delete invitations
DELETE FROM invitations;

-- Step 5: Delete audit logs
DELETE FROM audit_logs;

-- Step 6: Delete rate limits
DELETE FROM rate_limits;

-- Step 7: Delete consent configurations
DELETE FROM consent_configurations;

-- Step 8: Delete organization tag mappings
DELETE FROM org_tag_mappings;

-- Step 9: Delete organization members
DELETE FROM organization_members;

-- Step 10: Delete organizations
DELETE FROM organizations;

-- Step 11: Delete sessions
DELETE FROM sessions;

-- Step 12: Delete onboarding data
DELETE FROM onboarding_steps;
DELETE FROM onboarding_progress;

-- Step 13: Delete password reset tokens
DELETE FROM password_reset_tokens;

-- Step 14: Delete comments (test data from template)
DELETE FROM comments;

-- Step 15: Delete users
DELETE FROM users;

-- Verify cleanup (these should all return 0)
SELECT 'Users remaining:' as check_type, COUNT(*) as count FROM users
UNION ALL
SELECT 'Organizations remaining:', COUNT(*) FROM organizations
UNION ALL
SELECT 'Sessions remaining:', COUNT(*) FROM sessions
UNION ALL
SELECT 'Connections remaining:', COUNT(*) FROM platform_connections;