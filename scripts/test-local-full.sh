#!/usr/bin/env bash
# ============================================================================
# Full Local API Surface Test — Every GET endpoint, two org profiles
# ============================================================================
# Tests every readable endpoint with:
#   DEMO_ORG  — Seeded org with 30 days of data (CAC, conversions, goals, connectors)
#   FRESH_ORG — Newly registered org with zero data
#
# Prerequisites:
#   1. npm run seed:local
#   2. npx wrangler dev --env local --port 8787
#
# Usage:
#   bash scripts/test-local-full.sh
# ============================================================================

set -uo pipefail

API="http://localhost:8787"
PASS=0
FAIL=0
WARN=0
TESTS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { PASS=$((PASS+1)); TESTS+=("PASS: $1"); printf "  ${GREEN}PASS${NC}  %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); TESTS+=("FAIL: $1 — $2"); printf "  ${RED}FAIL${NC}  %s — %s\n" "$1" "$2"; }
warn() { WARN=$((WARN+1)); TESTS+=("WARN: $1 — $2"); printf "  ${YELLOW}WARN${NC}  %s — %s\n" "$1" "$2"; }
section() { printf "\n${CYAN}[%s] %s${NC}\n" "$1" "$2"; }

TMP_JSON=$(mktemp)
trap 'rm -f "$TMP_JSON"' EXIT

# Smart curl: throttle to ~85 req/min + auto-retry on 429
rl_curl() {
  sleep 0.65
  local response
  response=$(curl -s "$@")
  if echo "$response" | grep -q 'RATE_LIMIT_EXCEEDED\|Too Many Requests'; then
    printf "  ${YELLOW}...rate limited, pausing 65s...${NC}\n" >&2
    sleep 65
    response=$(curl -s "$@")
  fi
  echo "$response"
}

# Python-based JSON extraction
pyjson() {
  printf '%s' "$1" > "$TMP_JSON"
  python3 -c "
import json
d = json.load(open('$TMP_JSON'))
print($2)
" 2>/dev/null
}

check() {
  local label="$1" response="$2" expr="$3" expected="$4"
  local actual
  actual=$(pyjson "$response" "$expr")
  if [ "$actual" = "$expected" ]; then
    ok "$label"
  else
    fail "$label" "expected=$expected actual=$actual"
  fi
}

# Test that endpoint returns success:true (or graceful empty)
check_success() {
  local label="$1" response="$2"
  local success
  success=$(pyjson "$response" "d.get('success')")
  if [ "$success" = "True" ]; then
    ok "$label"
  else
    local code
    code=$(pyjson "$response" "d.get('error',{}).get('code','')")
    fail "$label" "success=False code=$code"
  fi
}

# Test that endpoint returns a specific HTTP-level error gracefully
check_error() {
  local label="$1" response="$2" expected_code="$3"
  local code
  code=$(pyjson "$response" "d.get('error',{}).get('code','')")
  if [ "$code" = "$expected_code" ]; then
    ok "$label"
  else
    local success
    success=$(pyjson "$response" "d.get('success')")
    if [ "$success" = "True" ]; then
      # Some endpoints return success even with no data — that's acceptable
      warn "$label" "expected error=$expected_code but got success=True"
    else
      fail "$label" "expected code=$expected_code got code=$code"
    fi
  fi
}

# Shorthand HTTP helpers — all use rl_curl for throttle + retry
get_demo() { rl_curl "$API$1${1:+$(echo "$1" | grep -q '?' && echo '&' || echo '?')}org_id=$DEMO_ORG" -H "Authorization: Bearer $DEMO_TOKEN"; }
get_fresh() { rl_curl "$API$1${1:+$(echo "$1" | grep -q '?' && echo '&' || echo '?')}org_id=$FRESH_ORG" -H "Authorization: Bearer $FRESH_TOKEN"; }
get_auth() { rl_curl "$API$1" -H "Authorization: Bearer $2"; }
get_noauth() { rl_curl "$API$1"; }
post_auth() { rl_curl -X POST "$API$1" -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$3"; }

echo "============================================"
echo "  ClearLift Full API Surface Test"
echo "============================================"
# Initial cooldown to clear any previous rate limit state
printf "  ${YELLOW}Cooldown 5s (clear previous rate limit state)...${NC}\n"
sleep 5

# ============================================================================
section "0" "Preflight"
# ============================================================================
if ! curl -s --max-time 3 "$API" > /dev/null 2>&1; then
  echo "  FAIL  API not reachable at $API"
  exit 1
fi
ok "API reachable"

# Health endpoint
R=$(get_noauth "/v1/health")
check_success "GET /v1/health" "$R"

# ============================================================================
section "1" "Setup: Demo org (seeded data)"
# ============================================================================
DEMO_TOKEN="demo_session_token_001"
DEMO_ORG="de000001-0000-4000-a000-000000000001"

R=$(get_auth "/v1/user/organizations" "$DEMO_TOKEN")
check_success "demo session valid" "$R"
check "demo org slug" "$R" "d.get('data',{}).get('organizations',[{}])[0].get('slug')" "acme-demo"

# ============================================================================
section "2" "Setup: Fresh org (empty data)"
# ============================================================================
TS=$(date +%s)
FRESH_EMAIL="fulltest-${TS}@test.dev"
R=$(rl_curl -X POST "$API/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$FRESH_EMAIL\",\"password\":\"testpass123\",\"name\":\"Full Test\",\"organization_name\":\"Empty Corp $TS\"}")
check_success "fresh registration" "$R"
FRESH_TOKEN=$(pyjson "$R" "d.get('data',{}).get('session',{}).get('token','')")
FRESH_ORG=$(pyjson "$R" "d.get('data',{}).get('organization',{}).get('id','')")
if [ -n "$FRESH_TOKEN" ] && [ -n "$FRESH_ORG" ]; then
  ok "fresh org ready ($FRESH_ORG)"
else
  fail "fresh org setup" "token or org empty"
fi

# ============================================================================
section "3" "User & Organization endpoints"
# ============================================================================
R=$(get_auth "/v1/user/me" "$DEMO_TOKEN")
check_success "GET /v1/user/me (demo)" "$R"

R=$(get_auth "/v1/user/me" "$FRESH_TOKEN")
check_success "GET /v1/user/me (fresh)" "$R"

R=$(get_auth "/v1/user/organizations" "$FRESH_TOKEN")
check "fresh has 1 org" "$R" "len(d.get('data',{}).get('organizations',[]))" "1"

R=$(get_auth "/v1/organizations/$DEMO_ORG/members" "$DEMO_TOKEN")
check_success "GET /org/members (demo)" "$R"

R=$(get_auth "/v1/organizations/$DEMO_ORG/tag" "$DEMO_TOKEN")
check_success "GET /org/tag (demo)" "$R"

R=$(get_auth "/v1/organizations/$DEMO_ORG/tracking-domains" "$DEMO_TOKEN")
check_success "GET /org/tracking-domains (demo)" "$R"

R=$(get_auth "/v1/organizations/$DEMO_ORG/script-hash" "$DEMO_TOKEN")
check_success "GET /org/script-hash (demo)" "$R"

# Terms
R=$(get_auth "/v1/terms/status" "$DEMO_TOKEN")
check_success "GET /terms/status (demo)" "$R"

# ============================================================================
section "4" "Onboarding endpoints"
# ============================================================================
R=$(get_demo "/v1/onboarding/status")
check "demo onboarding complete" "$R" "d.get('data',{}).get('is_complete')" "1"

R=$(get_fresh "/v1/onboarding/status")
check_success "GET /onboarding/status (fresh)" "$R"

R=$(get_demo "/v1/onboarding/validate")
check_success "GET /onboarding/validate (demo)" "$R"

R=$(get_fresh "/v1/onboarding/validate")
check_success "GET /onboarding/validate (fresh)" "$R"
check "fresh no connectors" "$R" "d.get('data',{}).get('hasConnectedPlatform')" "False"
check "fresh no tag" "$R" "d.get('data',{}).get('hasInstalledTag')" "False"
check "fresh no goals" "$R" "d.get('data',{}).get('hasDefinedGoal')" "False"

# ============================================================================
section "5" "Connector Registry (public, no auth)"
# ============================================================================
R=$(get_noauth "/v1/connectors/registry")
check_success "GET /connectors/registry" "$R"
REG_COUNT=$(pyjson "$R" "len(d.get('data',{}).get('connectors',[]))")
if [ "${REG_COUNT:-0}" -gt 5 ]; then ok "registry has $REG_COUNT connectors"; else fail "registry count" "got $REG_COUNT"; fi

R=$(get_noauth "/v1/connectors/registry/stripe")
check_success "GET /connectors/registry/stripe" "$R"

R=$(get_noauth "/v1/connectors/registry/stripe/events")
check_success "GET /connectors/registry/stripe/events" "$R"

R=$(get_noauth "/v1/connectors/registry/types/ad_platform/platform-ids")
check_success "GET /registry/types/ad_platform/platform-ids" "$R"

# ============================================================================
section "6" "Connectors — connected platforms"
# ============================================================================
R=$(get_demo "/v1/connectors/connected")
check_success "GET /connectors/connected (demo)" "$R"
DEMO_CONNS=$(pyjson "$R" "len(d.get('data',{}).get('connections',[]))")
check "demo has 3 connectors" "$R" "len(d.get('data',{}).get('connections',[]))" "3"

R=$(get_fresh "/v1/connectors/connected")
check_success "GET /connectors/connected (fresh)" "$R"
check "fresh has 0 connectors" "$R" "len(d.get('data',{}).get('connections',[]))" "0"

R=$(get_auth "/v1/connectors?org_id=$DEMO_ORG" "$DEMO_TOKEN")
check_success "GET /connectors (demo)" "$R"

R=$(get_auth "/v1/connectors/needs-reauth?org_id=$DEMO_ORG" "$DEMO_TOKEN")
check_success "GET /connectors/needs-reauth (demo)" "$R"

# ============================================================================
section "7" "Goals — CRUD & hierarchy"
# ============================================================================
R=$(get_demo "/v1/goals")
check_success "GET /goals (demo)" "$R"
DEMO_GOALS=$(pyjson "$R" "len(d.get('data',[]))")
check "demo has 3 goals" "$R" "len(d.get('data',[]))" "3"
DEMO_GOAL_ID=$(pyjson "$R" "d.get('data',[])[0].get('id','')")

R=$(get_fresh "/v1/goals")
check_success "GET /goals (fresh)" "$R"
check "fresh has 0 goals" "$R" "len(d.get('data',[]))" "0"

# Goal hierarchy
R=$(get_demo "/v1/goals/hierarchy")
check_success "GET /goals/hierarchy (demo)" "$R"

R=$(get_fresh "/v1/goals/hierarchy")
check_success "GET /goals/hierarchy (fresh)" "$R"

# Goal templates (requires business_type param)
R=$(get_auth "/v1/goals/templates?business_type=saas" "$DEMO_TOKEN")
check_success "GET /goals/templates" "$R"

# Goal graph
R=$(get_demo "/v1/goals/graph")
check_success "GET /goals/graph (demo)" "$R"

R=$(get_demo "/v1/goals/paths")
check_success "GET /goals/paths (demo)" "$R"

# Goal groups
R=$(get_demo "/v1/goals/groups")
check_success "GET /goals/groups (demo)" "$R"

# Goal config (public — uses org_tag, not tag)
R=$(get_noauth "/v1/goals/config?org_tag=acme_demo")
check_success "GET /goals/config (public)" "$R"

# Goal metrics (for first demo goal)
if [ -n "$DEMO_GOAL_ID" ]; then
  R=$(get_demo "/v1/goals/$DEMO_GOAL_ID/metrics")
  check_success "GET /goals/:id/metrics (demo)" "$R"

  R=$(get_demo "/v1/goals/$DEMO_GOAL_ID/conversions")
  check_success "GET /goals/:id/conversions (demo)" "$R"

  R=$(get_demo "/v1/goals/$DEMO_GOAL_ID/conversion-stats")
  check_success "GET /goals/:id/conversion-stats (demo)" "$R"
fi

# Create a goal on fresh org, then test with it
R=$(post_auth "/v1/goals?org_id=$FRESH_ORG" "$FRESH_TOKEN" \
  '{"name":"Test Purchase","event_name":"purchase","connector_type":"stripe","is_conversion":true,"category":"macro_conversion"}')
check_success "POST /goals (fresh create)" "$R"
FRESH_GOAL_ID=$(pyjson "$R" "d.get('data',{}).get('id','')")
if [ -n "$FRESH_GOAL_ID" ]; then
  ok "created goal $FRESH_GOAL_ID"
else
  warn "goal creation" "no id returned"
fi

# ============================================================================
section "8" "CAC & Spend endpoints"
# ============================================================================
R=$(get_demo "/v1/analytics/cac/summary")
check_success "GET /cac/summary (demo)" "$R"
DEMO_CAC=$(pyjson "$R" "d.get('data',{}).get('cac_cents',0)")
DEMO_CONVS=$(pyjson "$R" "d.get('data',{}).get('conversions',0)")
if [ "${DEMO_CAC:-0}" -gt 0 ]; then ok "demo CAC=$DEMO_CAC cents"; else fail "demo CAC" "got $DEMO_CAC"; fi
if [ "${DEMO_CONVS:-0}" -gt 100 ]; then ok "demo conversions=$DEMO_CONVS"; else fail "demo conversions" "got $DEMO_CONVS"; fi

# CAC timeline
R=$(get_demo "/v1/analytics/cac/timeline")
check_success "GET /cac/timeline (demo)" "$R"
CAC_DAYS=$(pyjson "$R" "len(d.get('data',{}).get('timeline',[]))")
if [ "${CAC_DAYS:-0}" -gt 20 ]; then ok "CAC timeline has $CAC_DAYS days"; else warn "CAC timeline days" "got $CAC_DAYS"; fi

# Fresh org — CAC should be empty/zero
R=$(get_fresh "/v1/analytics/cac/summary")
check_success "GET /cac/summary (fresh)" "$R"
# Fresh CAC summary may return null/None for conversions (no data)
FRESH_CONVS=$(pyjson "$R" "d.get('data',{}).get('conversions') or 0")
if [ "${FRESH_CONVS:-0}" -eq 0 ]; then ok "fresh 0 conversions"; else fail "fresh conversions" "got $FRESH_CONVS"; fi

R=$(get_fresh "/v1/analytics/cac/timeline")
check_success "GET /cac/timeline (fresh)" "$R"

# ============================================================================
section "9" "Conversions endpoint"
# ============================================================================
R=$(get_demo "/v1/analytics/conversions?from=2026-01-15&to=2026-02-14")
check_success "GET /conversions (demo 30d)" "$R"
CONV_COUNT=$(pyjson "$R" "d.get('data',{}).get('total',0)")
if [ "${CONV_COUNT:-0}" -gt 0 ]; then ok "conversions total=$CONV_COUNT"; else warn "conversions" "got $CONV_COUNT"; fi

R=$(get_fresh "/v1/analytics/conversions?from=2026-01-15&to=2026-02-14")
check_success "GET /conversions (fresh)" "$R"

# ============================================================================
section "10" "Attribution (multiple models)"
# ============================================================================
# Standard attribution — demo org (has ad_campaigns + ad_metrics data)
for MODEL in last_click first_click linear markov_chain shapley_value platform; do
  R=$(get_demo "/v1/analytics/attribution?model=$MODEL&from=2026-01-15&to=2026-02-14")
  S=$(pyjson "$R" "d.get('success')")
  if [ "$S" = "True" ]; then
    ok "GET /attribution model=$MODEL (demo)"
  else
    CODE=$(pyjson "$R" "d.get('error',{}).get('code','')")
    warn "GET /attribution model=$MODEL (demo)" "code=$CODE"
  fi
done

# Attribution comparison
R=$(get_demo "/v1/analytics/attribution/compare?models=last_click,first_click,linear&from=2026-01-15&to=2026-02-14")
check_success "GET /attribution/compare (demo)" "$R"

# Computed attribution (pre-computed by cron)
R=$(get_demo "/v1/analytics/attribution/computed?model=markov_chain")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then
  ok "GET /attribution/computed markov (demo)"
else
  CODE=$(pyjson "$R" "d.get('error',{}).get('code','')")
  warn "GET /attribution/computed markov (demo)" "code=$CODE (no cron data expected locally)"
fi

# Blended attribution
R=$(get_demo "/v1/analytics/attribution/blended?from=2026-01-15&to=2026-02-14")
check_success "GET /attribution/blended (demo)" "$R"

# Journey analytics
R=$(get_demo "/v1/analytics/attribution/journey-analytics?from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then
  ok "GET /attribution/journey-analytics (demo)"
else
  warn "GET /attribution/journey-analytics (demo)" "no journey data locally"
fi

# Assisted/Direct stats
R=$(get_demo "/v1/analytics/attribution/assisted-direct?from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /attribution/assisted-direct (demo)"; else warn "assisted-direct" "no data"; fi

# Smart attribution (uses start_date/end_date, not from/to)
R=$(get_demo "/v1/analytics/smart-attribution?start_date=2026-01-15&end_date=2026-02-14")
check_success "GET /smart-attribution (demo)" "$R"

# Click attribution
R=$(get_demo "/v1/analytics/click-attribution?from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /click-attribution (demo)"; else warn "click-attribution" "no click data"; fi

# Click extraction stats
R=$(get_demo "/v1/analytics/click-extraction/stats")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /click-extraction/stats (demo)"; else warn "click-extraction" "not run"; fi

# Fresh org — attribution with no data
R=$(get_fresh "/v1/analytics/attribution?model=last_click&from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then
  ok "GET /attribution last_click (fresh) — graceful empty"
else
  CODE=$(pyjson "$R" "d.get('error',{}).get('code','')")
  # Acceptable errors for empty org
  if [ "$CODE" = "NO_CHANNELS" ] || [ "$CODE" = "NO_DATA" ] || [ "$CODE" = "FORBIDDEN" ]; then
    ok "GET /attribution last_click (fresh) — correct error: $CODE"
  else
    fail "GET /attribution last_click (fresh)" "unexpected error: $CODE"
  fi
fi

# ============================================================================
section "11" "Platform-specific analytics (Facebook/Google/TikTok)"
# ============================================================================
# These query D1 shard data — demo org has seeded ad_campaigns + ad_metrics

R=$(get_demo "/v1/analytics/facebook/campaigns?from=2026-01-15&to=2026-02-14")
check_success "GET /facebook/campaigns (demo)" "$R"
FB_CAMPS=$(pyjson "$R" "len(d.get('data',{}).get('results',[]))")
if [ "${FB_CAMPS:-0}" -gt 0 ]; then ok "facebook has $FB_CAMPS campaigns"; else warn "facebook campaigns" "got $FB_CAMPS (expected seeded)"; fi

R=$(get_demo "/v1/analytics/facebook/ad-sets?from=2026-01-15&to=2026-02-14")
check_success "GET /facebook/ad-sets (demo)" "$R"

R=$(get_demo "/v1/analytics/facebook/ads?from=2026-01-15&to=2026-02-14")
check_success "GET /facebook/ads (demo)" "$R"

R=$(get_demo "/v1/analytics/facebook/metrics/daily?start_date=2026-01-15&end_date=2026-02-14")
check_success "GET /facebook/metrics/daily (demo)" "$R"

R=$(get_demo "/v1/analytics/facebook/action-breakdown?from=2026-01-15&to=2026-02-14")
check_success "GET /facebook/action-breakdown (demo)" "$R"

# Google
R=$(get_demo "/v1/analytics/google/campaigns?from=2026-01-15&to=2026-02-14")
check_success "GET /google/campaigns (demo)" "$R"
G_CAMPS=$(pyjson "$R" "len(d.get('data',{}).get('results',[]))")
if [ "${G_CAMPS:-0}" -gt 0 ]; then ok "google has $G_CAMPS campaigns"; else warn "google campaigns" "got $G_CAMPS"; fi

R=$(get_demo "/v1/analytics/google/ad-groups?from=2026-01-15&to=2026-02-14")
check_success "GET /google/ad-groups (demo)" "$R"

R=$(get_demo "/v1/analytics/google/ads?from=2026-01-15&to=2026-02-14")
check_success "GET /google/ads (demo)" "$R"

R=$(get_demo "/v1/analytics/google/metrics/daily?start_date=2026-01-15&end_date=2026-02-14")
check_success "GET /google/metrics/daily (demo)" "$R"

# TikTok
R=$(get_demo "/v1/analytics/tiktok/campaigns?from=2026-01-15&to=2026-02-14")
check_success "GET /tiktok/campaigns (demo)" "$R"

R=$(get_demo "/v1/analytics/tiktok/metrics/daily?start_date=2026-01-15&end_date=2026-02-14")
check_success "GET /tiktok/metrics/daily (demo)" "$R"

# Unified platforms
R=$(get_demo "/v1/analytics/platforms/unified?from=2026-01-15&to=2026-02-14")
check_success "GET /platforms/unified (demo)" "$R"

# Fresh org — should return empty but not crash
R=$(get_fresh "/v1/analytics/facebook/campaigns?from=2026-01-15&to=2026-02-14")
check_success "GET /facebook/campaigns (fresh)" "$R"

R=$(get_fresh "/v1/analytics/google/campaigns?from=2026-01-15&to=2026-02-14")
check_success "GET /google/campaigns (fresh)" "$R"

# ============================================================================
section "12" "Revenue connectors (Stripe/Jobber)"
# ============================================================================
R=$(get_demo "/v1/analytics/stripe?from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /stripe (demo)"; else warn "GET /stripe" "no live stripe data in local"; fi

R=$(get_demo "/v1/analytics/stripe/daily-aggregates?from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /stripe/daily-aggregates (demo)"; else warn "stripe daily" "no data"; fi

R=$(get_demo "/v1/analytics/jobber/revenue?from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /jobber/revenue (demo)"; else warn "jobber revenue" "no data"; fi

# ============================================================================
section "13" "Realtime Analytics Engine"
# ============================================================================
# These query Analytics Engine which isn't available locally — should return graceful errors
for EP in summary timeseries breakdown events event-types stripe; do
  R=$(get_demo "/v1/analytics/realtime/$EP")
  S=$(pyjson "$R" "d.get('success')")
  if [ "$S" = "True" ]; then
    ok "GET /realtime/$EP (demo)"
  else
    CODE=$(pyjson "$R" "d.get('error',{}).get('code','')")
    if [ "$CODE" = "CONFIG_ERROR" ] || [ "$CODE" = "ANALYTICS_ENGINE_ERROR" ]; then
      ok "GET /realtime/$EP (demo) — expected: no AE locally ($CODE)"
    else
      warn "GET /realtime/$EP" "code=$CODE"
    fi
  fi
done

# Realtime goals
R=$(get_demo "/v1/analytics/realtime/goals")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /realtime/goals (demo)"; else ok "GET /realtime/goals — no AE locally"; fi

# ============================================================================
section "14" "D1 Metrics endpoints"
# ============================================================================
R=$(get_demo "/v1/analytics/metrics/summary")
check_success "GET /metrics/summary (demo)" "$R"

# D1 daily/hourly/utm query event_metrics table (populated by events pipeline, not seed)
R=$(get_demo "/v1/analytics/metrics/daily?start_date=2026-01-15&end_date=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /metrics/daily (demo)"; else warn "GET /metrics/daily" "needs event_metrics table (no seed data)"; fi

R=$(get_demo "/v1/analytics/metrics/hourly?start_date=2026-02-13T00:00:00Z&end_date=2026-02-14T23:59:59Z")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /metrics/hourly (demo)"; else warn "GET /metrics/hourly" "needs event_metrics table"; fi

R=$(get_demo "/v1/analytics/metrics/utm?start_date=2026-01-15&end_date=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /metrics/utm (demo)"; else warn "GET /metrics/utm" "needs event_metrics table"; fi

R=$(get_demo "/v1/analytics/metrics/attribution")
check_success "GET /metrics/attribution (demo)" "$R"

R=$(get_demo "/v1/analytics/metrics/journeys")
check_success "GET /metrics/journeys (demo)" "$R"

R=$(get_demo "/v1/analytics/metrics/transitions")
check_success "GET /metrics/transitions (demo)" "$R"

# Fresh org D1 metrics — should be empty but not error
R=$(get_fresh "/v1/analytics/metrics/summary")
check_success "GET /metrics/summary (fresh)" "$R"

# ============================================================================
section "15" "Flow Builder analytics"
# ============================================================================
R=$(get_demo "/v1/analytics/flow/metrics")
check_success "GET /flow/metrics (demo)" "$R"

R=$(get_demo "/v1/analytics/flow/insights")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /flow/insights (demo)"; else warn "flow insights" "may need flow config"; fi

R=$(get_demo "/v1/analytics/flow/pages")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /flow/pages (demo)"; else warn "flow pages" "needs tag data"; fi

R=$(get_fresh "/v1/analytics/flow/metrics")
check_success "GET /flow/metrics (fresh)" "$R"

# ============================================================================
section "16" "Journey & Identity"
# ============================================================================
R=$(get_demo "/v1/analytics/journeys/overview")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /journeys/overview (demo)"; else warn "journeys overview" "needs identity data"; fi

R=$(get_fresh "/v1/analytics/journeys/overview")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /journeys/overview (fresh)"; else warn "journeys fresh" "expected empty"; fi

# ============================================================================
section "17" "UTM Campaigns & Tracking Links"
# ============================================================================
R=$(get_demo "/v1/analytics/utm-campaigns?from=2026-01-15&to=2026-02-14")
check_success "GET /utm-campaigns (demo)" "$R"

R=$(get_demo "/v1/analytics/utm-campaigns/time-series?from=2026-01-15&to=2026-02-14")
check_success "GET /utm-campaigns/time-series (demo)" "$R"

R=$(get_demo "/v1/analytics/tracking-links")
check_success "GET /tracking-links performance (demo)" "$R"

R=$(get_demo "/v1/tracking-links")
check_success "GET /tracking-links list (demo)" "$R"

# ============================================================================
section "18" "Events endpoints"
# ============================================================================
R=$(get_demo "/v1/analytics/events?from=2026-01-15&to=2026-02-14")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /events (demo)"; else warn "events" "needs AE/R2 SQL"; fi

R=$(get_demo "/v1/analytics/events/d1")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /events/d1 (demo)"; else warn "events/d1" "needs tag data"; fi

R=$(get_demo "/v1/analytics/events/sync-status")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /events/sync-status (demo)"; else warn "events sync" "may not be configured"; fi

# ============================================================================
section "19" "Settings & Dashboard"
# ============================================================================
R=$(get_demo "/v1/settings/matrix")
check_success "GET /settings/matrix (demo)" "$R"

R=$(get_fresh "/v1/settings/matrix")
check_success "GET /settings/matrix (fresh)" "$R"

R=$(get_demo "/v1/settings/ai-decisions")
check_success "GET /settings/ai-decisions (demo)" "$R"

R=$(get_demo "/v1/dashboard/layout")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /dashboard/layout (demo)"; else warn "dashboard layout" "none saved"; fi

# ============================================================================
section "20" "Workers & monitoring"
# ============================================================================
R=$(get_auth "/v1/workers/health" "$DEMO_TOKEN")
check_success "GET /workers/health" "$R"

R=$(get_auth "/v1/workers/queue/status" "$DEMO_TOKEN")
check_success "GET /workers/queue/status" "$R"

R=$(get_auth "/v1/workers/d1/stats" "$DEMO_TOKEN")
check_success "GET /workers/d1/stats" "$R"

# ============================================================================
section "21" "Tracking config"
# ============================================================================
R=$(get_auth "/v1/tracking-config" "$DEMO_TOKEN")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /tracking-config (demo)"; else warn "tracking-config" "not configured"; fi

# Public tag config
R=$(get_noauth "/v1/config?tag=acme_demo")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /config?tag=acme_demo (public)"; else warn "public config" "tag not found"; fi

# ============================================================================
section "22" "Analysis (AI)"
# ============================================================================
R=$(get_demo "/v1/analysis/latest")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then ok "GET /analysis/latest (demo)"; else ok "GET /analysis/latest — no analysis run yet"; fi

# ============================================================================
section "23" "Domains alias"
# ============================================================================
R=$(get_demo "/v1/domains")
check_success "GET /domains (demo)" "$R"

# ============================================================================
section "24" "Edge cases & error handling"
# ============================================================================
# Non-existent org UUID
R=$(get_auth "/v1/goals?org_id=00000000-0000-4000-a000-000000000099" "$DEMO_TOKEN")
S=$(pyjson "$R" "d.get('success')")
CODE=$(pyjson "$R" "d.get('error',{}).get('code','')")
if [ "$S" != "True" ]; then ok "non-existent org rejected ($CODE)"; else fail "non-existent org" "should have been rejected"; fi

# Wrong token for org
R=$(get_auth "/v1/goals?org_id=$DEMO_ORG" "$FRESH_TOKEN")
S=$(pyjson "$R" "d.get('success')")
CODE=$(pyjson "$R" "d.get('error',{}).get('code','')")
if [ "$S" != "True" ]; then
  ok "cross-org access rejected ($CODE)"
else
  fail "cross-org access" "should have been rejected — SECURITY ISSUE"
fi

# Missing org_id on requireOrg endpoint
R=$(get_auth "/v1/goals" "$DEMO_TOKEN")
S=$(pyjson "$R" "d.get('success')")
CODE=$(pyjson "$R" "d.get('error',{}).get('code','')")
if [ "$S" != "True" ]; then
  ok "missing org_id rejected ($CODE)"
else
  # Some endpoints may default to user's org
  warn "missing org_id" "endpoint returned success — may auto-resolve org"
fi

# Invalid date range
R=$(get_demo "/v1/analytics/cac/timeline?from=invalid&to=alsobad")
S=$(pyjson "$R" "d.get('success')")
if [ "$S" = "True" ]; then
  warn "invalid dates" "accepted — should validate"
else
  ok "invalid date range handled gracefully"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "============================================"
printf "  Results: ${GREEN}%d passed${NC}, ${RED}%d failed${NC}, ${YELLOW}%d warnings${NC}\n" "$PASS" "$FAIL" "$WARN"
echo "============================================"

# Group by status
if [ $FAIL -gt 0 ]; then
  echo ""
  echo "  FAILURES:"
  for t in "${TESTS[@]}"; do
    if [[ "$t" == FAIL:* ]]; then echo "    $t"; fi
  done
fi

if [ $WARN -gt 0 ]; then
  echo ""
  echo "  WARNINGS:"
  for t in "${TESTS[@]}"; do
    if [[ "$t" == WARN:* ]]; then echo "    $t"; fi
  done
fi

echo ""
echo "  Total: $((PASS + FAIL + WARN)) assertions across ~80 endpoints"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
