#!/bin/bash

# Test script for ClearLift API database access
# Usage: ./test-database-access.sh [debug-token]

API_URL="https://clearlift-api.paul-33c.workers.dev"
DEBUG_TOKEN="${1:-debug-2024}"

echo "==============================================="
echo "Testing ClearLift API Database Access"
echo "API URL: $API_URL"
echo "==============================================="
echo ""

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check (No Auth Required)
echo "1. Testing Health Endpoint (Public)..."
echo "   GET $API_URL/health"
echo ""
HEALTH_RESPONSE=$(curl -s "$API_URL/health")
echo "$HEALTH_RESPONSE" | jq '.' 2>/dev/null || echo "$HEALTH_RESPONSE"
echo ""

# Parse health response
if echo "$HEALTH_RESPONSE" | grep -q '"status":"healthy"'; then
    echo -e "${GREEN}✓ API is healthy${NC}"
    
    # Check database bindings
    if echo "$HEALTH_RESPONSE" | grep -q '"db":true'; then
        echo -e "${GREEN}✓ Main DB binding detected${NC}"
    else
        echo -e "${RED}✗ Main DB binding not found${NC}"
    fi
    
    if echo "$HEALTH_RESPONSE" | grep -q '"ad_data":true'; then
        echo -e "${GREEN}✓ AD_DATA binding detected${NC}"
    else
        echo -e "${RED}✗ AD_DATA binding not found${NC}"
    fi
    
    if echo "$HEALTH_RESPONSE" | grep -q '"ducklake":true'; then
        echo -e "${GREEN}✓ DuckLake binding detected${NC}"
    else
        echo -e "${YELLOW}⚠ DuckLake binding not found (optional)${NC}"
    fi
else
    echo -e "${RED}✗ API health check failed${NC}"
fi

echo ""
echo "==============================================="
echo ""

# Test 2: Debug Database Info
echo "2. Testing Debug Database Endpoint..."
echo "   GET $API_URL/debug/databases"
echo "   Using debug token: $DEBUG_TOKEN"
echo ""
DB_RESPONSE=$(curl -s -H "x-debug-token: $DEBUG_TOKEN" "$API_URL/debug/databases")
echo "$DB_RESPONSE" | jq '.' 2>/dev/null || echo "$DB_RESPONSE"
echo ""

# Check if debug token worked
if echo "$DB_RESPONSE" | grep -q '"error":"Invalid debug token"'; then
    echo -e "${RED}✗ Debug token invalid. Set DEBUG_TOKEN environment variable in Cloudflare.${NC}"
    echo "   To fix: Add DEBUG_TOKEN secret in Cloudflare dashboard"
else
    # Parse database info
    if echo "$DB_RESPONSE" | grep -q '"connected":true'; then
        echo -e "${GREEN}✓ Database connections successful${NC}"
        
        # Show table counts
        echo ""
        echo "Main DB Tables:"
        echo "$DB_RESPONSE" | jq -r '.main_db.tables[] | "  - \(.name): \(.row_count) rows"' 2>/dev/null
        
        echo ""
        echo "AD_DATA Tables:"
        echo "$DB_RESPONSE" | jq -r '.ad_data.tables[] | "  - \(.name): \(.row_count) rows"' 2>/dev/null
    else
        echo -e "${YELLOW}⚠ Some database connections failed${NC}"
    fi
fi

echo ""
echo "==============================================="
echo ""

# Test 3: Migration Status
echo "3. Testing Migration Status..."
echo "   GET $API_URL/debug/migrations"
echo ""
MIG_RESPONSE=$(curl -s -H "x-debug-token: $DEBUG_TOKEN" "$API_URL/debug/migrations")
echo "$MIG_RESPONSE" | jq '.' 2>/dev/null || echo "$MIG_RESPONSE"
echo ""

if ! echo "$MIG_RESPONSE" | grep -q '"error"'; then
    echo "Applied Migrations:"
    echo "Main DB:"
    echo "$MIG_RESPONSE" | jq -r '.main_db.applied_migrations[]' 2>/dev/null | sed 's/^/  - /'
    echo ""
    echo "AD_DATA:"
    echo "$MIG_RESPONSE" | jq -r '.ad_data.applied_migrations[]' 2>/dev/null | sed 's/^/  - /'
fi

echo ""
echo "==============================================="
echo ""

# Test 4: Write Permissions
echo "4. Testing Write Permissions..."
echo "   POST $API_URL/debug/test-write"
echo ""
WRITE_RESPONSE=$(curl -s -X POST -H "x-debug-token: $DEBUG_TOKEN" "$API_URL/debug/test-write")
echo "$WRITE_RESPONSE" | jq '.' 2>/dev/null || echo "$WRITE_RESPONSE"
echo ""

if echo "$WRITE_RESPONSE" | grep -q '"can_write":true'; then
    echo -e "${GREEN}✓ Write permissions verified for databases${NC}"
else
    echo -e "${YELLOW}⚠ Some write permissions failed${NC}"
fi

echo ""
echo "==============================================="
echo ""

# Test 5: Test Auth Requirement
echo "5. Testing Authentication Requirement..."
echo "   GET $API_URL/api/user/profile (without auth)"
echo ""
AUTH_TEST=$(curl -s "$API_URL/api/user/profile")
if echo "$AUTH_TEST" | grep -q '"error":"Authentication required"'; then
    echo -e "${GREEN}✓ Authentication is properly required${NC}"
else
    echo -e "${RED}✗ Authentication check failed${NC}"
fi

echo ""
echo "==============================================="
echo "SUMMARY"
echo "==============================================="
echo ""
echo "To fully test the API:"
echo "1. Set DEBUG_TOKEN in Cloudflare Workers environment variables"
echo "2. Apply migrations to remote databases:"
echo "   - npx wrangler d1 migrations apply DB --remote"
echo "   - npx wrangler d1 migrations apply AD_DATA --remote --config migrations-ad-data"
echo "3. Create a test user and session to get an auth token"
echo "4. Test authenticated endpoints with the token"
echo ""
echo "Debug endpoints available:"
echo "  - $API_URL/health (public)"
echo "  - $API_URL/debug/databases (needs x-debug-token header)"
echo "  - $API_URL/debug/migrations (needs x-debug-token header)"
echo "  - $API_URL/debug/test-write (needs x-debug-token header)"
echo ""