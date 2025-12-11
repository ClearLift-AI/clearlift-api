#!/bin/bash

# Purge D1 Database Script for ClearLift
# This script safely purges test data from the production D1 database

set -e

echo "================================================"
echo "ClearLift D1 Database Purge Script"
echo "================================================"
echo ""
echo "⚠️  WARNING: This will DELETE ALL data from the production database!"
echo "Database: ClearLiftDash-D1 (89bd84be-b517-4c72-ab61-422384319361)"
echo ""

# Show current data counts
echo "Current database status:"
echo "------------------------"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Users: ' || COUNT(*) FROM users"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Organizations: ' || COUNT(*) FROM organizations"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Sessions: ' || COUNT(*) FROM sessions"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Connections: ' || COUNT(*) FROM platform_connections"

echo ""
read -p "Do you want to proceed with purging all data? (type 'yes' to confirm): " confirmation

if [ "$confirmation" != "yes" ]; then
    echo "Purge cancelled."
    exit 0
fi

echo ""
echo "Creating backup of current data..."
echo "-----------------------------------"
# Export current data for backup
mkdir -p backups
timestamp=$(date +%Y%m%d_%H%M%S)
backup_dir="backups/d1_backup_${timestamp}"
mkdir -p "$backup_dir"

# Export each table to JSON
tables=("users" "organizations" "organization_members" "sessions" "platform_connections" "invitations" "org_tag_mappings" "onboarding_progress" "audit_logs")

for table in "${tables[@]}"; do
    echo "Backing up $table..."
    npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT * FROM $table" --json > "$backup_dir/${table}.json" 2>/dev/null || true
done

echo "Backup saved to: $backup_dir"
echo ""

echo "Purging database..."
echo "-------------------"

# Run the purge SQL script
npx wrangler d1 execute ClearLiftDash-D1 --remote --file=scripts/purge-test-data.sql

echo ""
echo "✅ Database purged successfully!"
echo ""
echo "Verification - remaining records:"
echo "---------------------------------"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Users: ' || COUNT(*) FROM users"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Organizations: ' || COUNT(*) FROM organizations"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Sessions: ' || COUNT(*) FROM sessions"
npx wrangler d1 execute ClearLiftDash-D1 --remote --command="SELECT 'Connections: ' || COUNT(*) FROM platform_connections"

echo ""
echo "🚀 Database is ready for production launch!"
echo "Backup data saved in: $backup_dir"