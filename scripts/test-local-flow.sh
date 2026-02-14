#!/usr/bin/env bash
# ============================================================================
# Local E2E Flow Test — Register → Login → Onboarding → Dashboard
# ============================================================================
# Prerequisites:
#   1. npm run seed:local        (seed demo data)
#   2. npx wrangler dev --env local --port 8787  (start API)
#
# Usage:
#   bash scripts/test-local-flow.sh
# ============================================================================

set -uo pipefail

API="http://localhost:8787"
PASS=0
FAIL=0
TESTS=()

# Helpers
ok()   { PASS=$((PASS+1)); TESTS+=("PASS: $1"); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL+1)); TESTS+=("FAIL: $1 — $2"); echo "  FAIL  $1 — $2"; }

TMP_JSON=$(mktemp)
trap 'rm -f "$TMP_JSON"' EXIT

check_json() {
  local label="$1" response="$2" expr="$3" expected="$4"
  local actual
  printf '%s' "$response" > "$TMP_JSON"
  actual=$(python3 -c "
import json
d = json.load(open('$TMP_JSON'))
print($expr)
" 2>/dev/null || echo "PARSE_ERROR")
  if [ "$actual" = "$expected" ]; then
    ok "$label"
  else
    fail "$label" "expected=$expected actual=$actual"
  fi
}

extract() {
  local json_data="$1" expr="$2"
  printf '%s' "$json_data" > "$TMP_JSON"
  python3 -c "
import json
d = json.load(open('$TMP_JSON'))
print($expr)
" 2>/dev/null
}

echo "============================================"
echo "  ClearLift Local E2E Flow Test"
echo "============================================"
echo ""

# Verify API is running
echo "[0] Preflight"
if ! curl -s --max-time 3 "$API" > /dev/null 2>&1; then
  echo "  FAIL  API not reachable at $API"
  echo "  Start it with: npx wrangler dev --env local --port 8787"
  exit 1
fi
ok "API reachable at $API"
echo ""

# ============================================================================
# PART 1: Demo user (seeded data)
# ============================================================================
echo "[1] Seeded demo user"
DEMO_TOKEN="demo_session_token_001"
DEMO_ORG="de000001-0000-4000-a000-000000000001"

R=$(curl -s "$API/v1/user/organizations" -H "Authorization: Bearer $DEMO_TOKEN")
check_json "demo session valid" "$R" "d.get('success')" "True"
check_json "demo org exists" "$R" "d.get('data',{}).get('organizations',[{}])[0].get('slug')" "acme-demo"

R=$(curl -s "$API/v1/analytics/cac/summary?org_id=$DEMO_ORG" -H "Authorization: Bearer $DEMO_TOKEN")
check_json "CAC summary loads" "$R" "d.get('success')" "True"
CONVS=$(extract "$R" "d.get('data',{}).get('conversions',0)")
if [ "${CONVS:-0}" -gt 100 ]; then ok "CAC has $CONVS conversions (>100)"; else fail "CAC conversions" "got $CONVS"; fi

R=$(curl -s "$API/v1/connectors/connected?org_id=$DEMO_ORG" -H "Authorization: Bearer $DEMO_TOKEN")
CONN_COUNT=$(extract "$R" "len(d.get('data',{}).get('connections',[]))")
if [ "${CONN_COUNT:-0}" -eq 3 ]; then ok "3 connectors connected"; else fail "connector count" "got $CONN_COUNT"; fi

R=$(curl -s "$API/v1/goals?org_id=$DEMO_ORG" -H "Authorization: Bearer $DEMO_TOKEN")
GOAL_COUNT=$(extract "$R" "len(d.get('data',[]))")
if [ "${GOAL_COUNT:-0}" -eq 3 ]; then ok "3 goals defined"; else fail "goal count" "got $GOAL_COUNT"; fi

R=$(curl -s "$API/v1/onboarding/status?org_id=$DEMO_ORG" -H "Authorization: Bearer $DEMO_TOKEN")
check_json "demo onboarding complete" "$R" "d.get('data',{}).get('is_complete')" "1"
echo ""

# ============================================================================
# PART 2: Fresh registration flow
# ============================================================================
echo "[2] Registration"
TS=$(date +%s)
REG_EMAIL="e2e-${TS}@test.dev"

R=$(curl -s -X POST "$API/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$REG_EMAIL\",\"password\":\"testpass123\",\"name\":\"E2E Test\",\"organization_name\":\"E2E Corp $TS\"}")
check_json "register success" "$R" "d.get('success')" "True"
REG_TOKEN=$(extract "$R" "d.get('data',{}).get('session',{}).get('token','')")
REG_ORG=$(extract "$R" "d.get('data',{}).get('organization',{}).get('id','')")
REG_USER=$(extract "$R" "d.get('data',{}).get('user',{}).get('id','')")

if [ -n "$REG_TOKEN" ]; then ok "session token returned"; else fail "session token" "empty"; fi
if [ -n "$REG_ORG" ]; then ok "org created on register"; else fail "org creation" "empty"; fi
echo ""

# ============================================================================
# PART 3: Login
# ============================================================================
echo "[3] Login"
R=$(curl -s -X POST "$API/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$REG_EMAIL\",\"password\":\"testpass123\"}")
check_json "login success" "$R" "d.get('success')" "True"
LOGIN_TOKEN=$(extract "$R" "d.get('data',{}).get('session',{}).get('token','')")
LOGIN_ORGS=$(extract "$R" "len(d.get('data',{}).get('organizations',[]))")
if [ -n "$LOGIN_TOKEN" ]; then ok "login token returned"; else fail "login token" "empty"; fi
if [ "${LOGIN_ORGS:-0}" -ge 1 ]; then ok "login returns $LOGIN_ORGS org(s)"; else fail "login orgs" "got $LOGIN_ORGS"; fi

# Bad password
R=$(curl -s -X POST "$API/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$REG_EMAIL\",\"password\":\"wrongpassword\"}")
check_json "bad password rejected" "$R" "d.get('success')" "False"

# Duplicate registration
R=$(curl -s -X POST "$API/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$REG_EMAIL\",\"password\":\"testpass123\",\"name\":\"Dup\"}")
check_json "duplicate email rejected" "$R" "d.get('success')" "False"
echo ""

# ============================================================================
# PART 4: Onboarding flow
# ============================================================================
echo "[4] Onboarding"
T="$LOGIN_TOKEN"

R=$(curl -s "$API/v1/onboarding/status?org_id=$REG_ORG" -H "Authorization: Bearer $T")
check_json "onboarding not complete" "$R" "d.get('data',{}).get('is_complete')" "False"
check_json "starts at welcome" "$R" "d.get('data',{}).get('current_step')" "welcome"

# Update profile (step 1a)
R=$(curl -s -X PATCH "$API/v1/user/me" \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{"name":"E2E Updated Name"}')
check_json "profile update" "$R" "d.get('success')" "True"

# Complete welcome step
R=$(curl -s -X POST "$API/v1/onboarding/complete-step?org_id=$REG_ORG" \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{"step_name":"welcome"}')
check_json "welcome step" "$R" "d.get('data',{}).get('progress',{}).get('current_step')" "connect_services"

# Skip to connect_services complete (simulating skipping connectors)
R=$(curl -s -X POST "$API/v1/onboarding/complete-step?org_id=$REG_ORG" \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{"step_name":"connect_services"}')
check_json "connect step" "$R" "d.get('data',{}).get('progress',{}).get('current_step')" "first_sync"

# Complete first_sync (launch dashboard)
R=$(curl -s -X POST "$API/v1/onboarding/complete-step?org_id=$REG_ORG" \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{"step_name":"first_sync"}')
check_json "first_sync step" "$R" "d.get('data',{}).get('progress',{}).get('current_step')" "completed"

# Verify final state
R=$(curl -s "$API/v1/onboarding/status?org_id=$REG_ORG" -H "Authorization: Bearer $T")
check_json "onboarding complete" "$R" "d.get('data',{}).get('is_complete')" "True"
echo ""

# ============================================================================
# PART 5: Validation checks
# ============================================================================
echo "[5] Validation"
R=$(curl -s "$API/v1/onboarding/validate?org_id=$REG_ORG" -H "Authorization: Bearer $T")
check_json "has organization" "$R" "d.get('data',{}).get('hasOrganization')" "True"
check_json "no connectors (expected)" "$R" "d.get('data',{}).get('hasConnectedPlatform')" "False"
check_json "no tag (expected)" "$R" "d.get('data',{}).get('hasInstalledTag')" "False"
check_json "no goals (expected)" "$R" "d.get('data',{}).get('hasDefinedGoal')" "False"
echo ""

# ============================================================================
# PART 6: Session management
# ============================================================================
echo "[6] Session management"
# Session refresh — fresh sessions (<1 day) still return success:true with the
# same token (no rotation). Add Content-Type to avoid chanso 400 on empty POST.
R=$(curl -s -X POST "$API/v1/auth/refresh" \
  -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{}')
REFRESH_SUCCESS=$(extract "$R" "d.get('success')")
if [ "$REFRESH_SUCCESS" = "True" ]; then ok "session refresh accepted"; else fail "session refresh" "success=$REFRESH_SUCCESS"; fi

# Invalid token
R=$(curl -s "$API/v1/user/organizations" -H "Authorization: Bearer invalid_token_xxx")
check_json "invalid token rejected" "$R" "d.get('error',{}).get('code')" "UNAUTHORIZED"

# No token
R=$(curl -s "$API/v1/user/organizations")
check_json "missing token rejected" "$R" "d.get('error',{}).get('code')" "UNAUTHORIZED"
echo ""

# ============================================================================
# Summary
# ============================================================================
echo "============================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "============================================"
for t in "${TESTS[@]}"; do
  echo "  $t"
done
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
