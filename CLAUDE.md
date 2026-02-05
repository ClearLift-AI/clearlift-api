# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClearLift API Worker - A Cloudflare Workers-based API that serves as the authentication and data access layer for the ClearLift platform. This worker acts as a reverse proxy at api.clearlift.ai, handling authentication, session management, and routing requests to multiple data sources.

## Architecture

### Tech Stack
- **Runtime**: Cloudflare Workers (standard deployment, NOT containers)
- **Framework**: Hono with Chanfana for OpenAPI auto-generation
- **Database**: Cloudflare D1 (two databases - see below)
- **Testing**: Vitest with @cloudflare/vitest-pool-workers

### Data Sources

#### D1 Databases (Dual Database Architecture)

This API uses **two separate D1 databases** for isolation between operational and AI workloads:

| Binding | Database Name | Migrations Dir | Purpose |
|---------|--------------|----------------|---------|
| `DB` | ClearLiftDash-D1 | `migrations/` | Core operational data (users, sessions, orgs, connections) |
| `AI_DB` | clearlift-ai | `migrations-ai/` | AI recommendations, analysis logs, LLM audit trail |

**Why two databases?**
- Separates transactional application data from heavy analytical workloads
- AI tables can be cleared/rebuilt independently
- Different access patterns (frequent reads vs batch writes)

#### ANALYTICS_DB (D1 Analytics Database)

A third D1 database for pre-aggregated analytics (sub-millisecond queries):

| Binding | Database Name | Migrations Dir | Purpose |
|---------|--------------|----------------|---------|
| `ANALYTICS_DB` | clearlift-analytics-dev | `migrations-analytics/` | Aggregated metrics, attribution, journeys |

**Legacy Tables (per-platform):**
- `hourly_metrics`, `daily_metrics` - Pre-aggregated event metrics
- `utm_performance` - UTM campaign attribution
- `attribution_results` - Multi-touch attribution
- `journeys`, `channel_transitions` - Customer journey analysis
- `google_campaigns`, `facebook_campaigns`, `tiktok_campaigns` - Platform data (sync'd from queue-consumer)

**Unified Tables (new - supports 100+ connectors):**

| Migration | Category | Tables | Status |
|-----------|----------|--------|--------|
| 0019 | Ad Platforms | `ad_campaigns`, `ad_groups`, `ads`, `ad_metrics` | ✅ Implemented |
| 0020 | CRM | `crm_contacts`, `crm_companies`, `crm_deals`, `crm_activities` | ✅ Implemented |
| 0021 | Communication | `comm_campaigns`, `comm_subscribers`, `comm_engagements` | ✅ Implemented |
| 0022 | E-commerce | `ecommerce_customers`, `_orders`, `_order_items`, `_products`, `_refunds` | 🔧 Stubbed |
| 0023 | Payments | `payments_customers`, `_subscriptions`, `_transactions`, `_invoices`, `_plans` | 🔧 Stubbed |
| 0024 | Support | `support_customers`, `_tickets`, `_conversations`, `_messages` | 🔧 Stubbed |
| 0025 | Scheduling | `scheduling_customers`, `_services`, `_appointments`, `_availability` | 🔧 Stubbed |
| 0026 | Forms | `forms_definitions`, `_submissions`, `_responses` | 🔧 Stubbed |
| 0027 | Events | `events_definitions`, `_registrations`, `_attendees`, `_recordings` | 🔧 Stubbed |
| 0028 | Analytics | `analytics_users`, `_sessions`, `_events`, `_page_views` | 🔧 Stubbed |
| 0029 | Accounting | `accounting_customers`, `_invoices`, `_expenses`, `_payments`, `_accounts` | 🔧 Stubbed |
| 0030 | Attribution | `attribution_installs`, `_events`, `_revenue`, `_cohorts` | 🔧 Stubbed |
| 0031 | Reviews | `reviews_profiles`, `_items`, `_responses`, `_aggregates` | 🔧 Stubbed |
| 0032 | Affiliate | `affiliate_partners`, `_referrals`, `_conversions`, `_payouts` | 🔧 Stubbed |
| 0033 | Social | `social_profiles`, `_posts`, `_followers`, `_engagements`, `_metrics` | 🔧 Stubbed |

**Status Legend:**
- ✅ **Implemented**: Schema + service methods + connectors writing to unified tables (unified-only, no legacy writes)
- 🔧 **Stubbed**: Schema + D1UnifiedService methods + types defined, no connectors using them yet

**Migration Status (Jan 2026):** Ad platforms (Google, Facebook, TikTok) fully migrated - all writes and reads use unified tables only.

**API files migrated to unified `ad_metrics`:**
- `src/services/d1-analytics.ts` - `getGoogleCampaignMetrics()` and all platform methods
- `src/endpoints/v1/analytics/platforms.ts` - Cross-platform time series
- `src/endpoints/v1/analytics/cac-timeline.ts` - CAC backfill queries
- `src/endpoints/v1/analytics/flow-metrics.ts` - Flow stage metrics
- `src/workflows/analysis-workflow.ts` - CAC calculation
- `src/workflows/attribution-workflow.ts` - Click attribution
- `src/services/analysis/metrics-fetcher.ts` - AI metrics fetching
- `src/services/analysis/simulation-service.ts` - Budget simulation
- `src/services/analysis/exploration-tools.ts` - AI exploration
- `src/index.ts` - CAC history backfill cron

**Deprecated tables (legacy daily metrics - no longer written or read):**
- `google_campaign_daily_metrics`, `facebook_campaign_daily_metrics`, `tiktok_campaign_daily_metrics`
- `*_ad_group_daily_metrics`, `*_ad_set_daily_metrics`, `*_ad_daily_metrics`

The unified tables use a `platform`/`source_platform` column to distinguish source and `platform_fields`/`properties` JSON for platform-specific data.

See `clearlift-cron/docs/SHARED_CODE.md §21` for full unified architecture documentation.

#### D1 Sharding Infrastructure (SHARD_0-3)

Four shard databases for scaling platform data by organization:

| Binding | Database Name | Migrations Dir | Purpose |
|---------|--------------|----------------|---------|
| `SHARD_0` | clearlift-shard-0 | `shard-migrations/` | Org data (hash % 4 == 0) |
| `SHARD_1` | clearlift-shard-1 | `shard-migrations/` | Org data (hash % 4 == 1) |
| `SHARD_2` | clearlift-shard-2 | `shard-migrations/` | Org data (hash % 4 == 2) |
| `SHARD_3` | clearlift-shard-3 | `shard-migrations/` | Org data (hash % 4 == 3) |

**Shard Schema** (`shard-migrations/`):

| Migration | Tables | Status |
|-----------|--------|--------|
| `0001_platform_tables.sql` | Legacy: Google/Facebook/TikTok campaigns, ad_groups, ads, metrics | ❌ Deprecated |
| `0002_pre_aggregation_tables.sql` | `org_daily_summary`, `campaign_period_summary`, `platform_comparison`, `org_timeseries`, `aggregation_jobs` | ✅ Active |
| `0003_unified_ad_tables.sql` | `ad_campaigns`, `ad_groups`, `ads`, `ad_metrics` (unified schema) | ✅ Active |

**Routing:** Uses `ShardRouter` with FNV-1a consistent hashing. See `src/services/shard-router.ts`.

**Migration status:** Tracked in `shard_routing` table (per-org assignment).

**Local Development - Shard Migrations:**
```bash
# Apply shard migrations to all local shards
npx wrangler d1 migrations apply SHARD_0 --local --env local
npx wrangler d1 migrations apply SHARD_1 --local --env local
npx wrangler d1 migrations apply SHARD_2 --local --env local
npx wrangler d1 migrations apply SHARD_3 --local --env local

# Verify tables exist
npx wrangler d1 execute clearlift-shard-0 --local --env local \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

**Production - Shard Migrations:**
```bash
# Apply shard migrations to production shards (CAUTION: affects live data)
npx wrangler d1 migrations apply SHARD_0 --remote
npx wrangler d1 migrations apply SHARD_1 --remote
npx wrangler d1 migrations apply SHARD_2 --remote
npx wrangler d1 migrations apply SHARD_3 --remote
```

**Current Status (Feb 2026):**
- ✅ Shard databases created in Cloudflare
- ✅ Unified shard schema defined (`shard-migrations/0003_unified_ad_tables.sql`)
- ✅ `migrations_dir` configured in wrangler.jsonc for all environments
- ✅ Local migrations applied and tested
- ✅ AggregationService reads from shards (unified tables)
- ✅ DataWriter writes to shards via ShardRouter (clearlift-cron)
- ✅ Production migrations applied to all 4 shards (SHARD_0-3): 0001 (55 cmds), 0002 (18 cmds), 0003 (22 cmds)
- ⚠️ API read endpoints still query ANALYTICS_DB (not shards)

**Pending API Read Migration:**
These D1AnalyticsService methods should be updated to query shards:
- `getGoogleCampaignsWithMetrics()` - queries unified `ad_campaigns` + `ad_metrics`
- `getFacebookCampaignsWithMetrics()` - queries unified `ad_campaigns` + `ad_metrics`
- `getTikTokCampaignsWithMetrics()` - queries unified `ad_campaigns` + `ad_metrics`
- `getUnifiedPlatformSummary()` - queries unified tables

Summary endpoints can continue reading from ANALYTICS_DB (pre-aggregated by AggregationService).

#### Data Sources Summary

| Data Type | Storage | Query Layer | Notes |
|-----------|---------|-------------|-------|
| Real-time events | Analytics Engine | `/v1/analytics/realtime/*` | Sub-second queries |
| Event aggregations | D1 ANALYTICS_DB | `/v1/analytics/d1/*` | Pre-aggregated metrics |
| Platform campaigns | D1 Shards | `/v1/analytics/platforms` | Sharded by org |
| Platform metrics | D1 Shards | `/v1/analytics/platforms` | Sharded by org |
| Raw events (archive) | R2 SQL | `/v1/analytics/events` | 15-25s queries, 96-field schema |

#### Other Data Sources
1. **Analytics Engine** - Real-time event analytics with < 100ms latency (90-day retention). Layout: 1 index (org_tag) + 19 blobs + 11 doubles.
2. **R2 SQL** - Historical event archive (Iceberg tables). Primary: `clearlift.event_data_v5` (96 fields, v3.1.0). Legacy: `clearlift.event_data` (backward compat).

### Key Architectural Points
- This API worker does NOT use containers
- Authentication flow: CF Access JWT → Session validation in D1 → Organization scope check
- The `short_tag` in org_tag_mappings table is used as the `org_tag` field filter in R2 SQL queries
- R2 SQL queries are executed directly via the REST API (no separate worker needed)

## Database Schema

### Main Database (DB) - `migrations/`

Core operational tables:

1. **users** - User accounts
   - `id`, `email`, `issuer`, `access_sub` (CF Access subject)
   - Links to sessions and organization_members

2. **sessions** - Active user sessions
   - `token` (primary key), `user_id`, `expires_at`
   - Used for API authentication after CF Access validation

3. **organizations** - Workspaces/accounts
   - `id`, `name`, `slug`, `subscription_tier`

4. **organization_members** - User-org relationships
   - `organization_id`, `user_id`, `role` (viewer/admin/owner)

5. **platform_connections** - OAuth connections to ad platforms
   - `organization_id`, `platform`, `account_id`
   - Tracks sync status and settings

6. **invitations** - Pending org invitations
   - `organization_id`, `email`, `token`, `expires_at`

7. **org_tag_mappings** - **Critical for data access**
   - Maps `organization_id` to `short_tag`
   - The `short_tag` is used as the `org_tag` field filter in R2 SQL queries
   - Example: org "acme-corp" → short_tag "a3f7c2" → query R2 SQL with org_tag="a3f7c2"

8. **ai_optimization_settings** - User AI preferences (Matrix settings)
   - `org_id`, `growth_strategy`, `budget_optimization`, `ai_control`
   - LLM settings: `llm_default_provider`, `llm_claude_model`, `llm_gemini_model`
   - `custom_instructions` for business context

### AI Database (AI_DB) - `migrations-ai/`

AI-specific tables (isolated for performance):

1. **ai_decisions** - Pending AI recommendations
   - `organization_id`, `tool`, `platform`, `entity_type`, `entity_id`
   - `parameters` (JSON), `reason`, `predicted_impact`, `confidence`
   - `status`: pending → approved/rejected → executed/failed/expired

2. **ai_tool_registry** - Available tools per platform (seed data included)
   - `tool`, `platform`, `entity_types`, `constraints`, `api_endpoint`
   - Pre-seeded: set_budget, set_status, set_age_range for FB/Google/TikTok

3. **ai_org_configs** - Per-org AI settings
   - `is_enabled`, `auto_execute`, `min_confidence`, `decision_ttl_days`

4. **analysis_prompts** - LLM prompt templates (seed data included)
   - `slug`, `level`, `platform`, `template`
   - Pre-seeded templates for ad/adset/campaign/account/cross_platform levels

5. **analysis_logs** - LLM audit trail
   - `provider`, `model`, `input_tokens`, `output_tokens`, `latency_ms`
   - Full `prompt` and `response` for debugging

6. **analysis_summaries** - Cached analysis results
   - `level`, `entity_id`, `summary`, `analysis_run_id`, `expires_at`

7. **analysis_jobs** - Async job tracking
   - `status`: pending → running → completed/failed
   - `total_entities`, `processed_entities`, `current_level`

8. **attribution_model_results** - Pre-computed attribution (Markov/Shapley)
   - `organization_id`, `model` ('markov_chain' or 'shapley_value'), `channel`
   - `attributed_credit` (0-1 normalized), `removal_effect` (Markov), `shapley_value` (Shapley)
   - `computation_date`, `expires_at` (7-day TTL)
   - Populated by Attribution Workflow, read by attribution endpoint

## Development Commands

```bash
# Install dependencies
npm install

# Run development server (see Local vs Remote below)
npx wrangler dev --env local --port 8787

# Apply D1 migrations locally (BOTH databases)
npx wrangler d1 migrations apply DB --local --env local      # Main database
npx wrangler d1 migrations apply AI_DB --local --env local   # AI database

# Apply D1 migrations to production (BOTH databases)
npx wrangler d1 migrations apply DB --remote      # Main database
npx wrangler d1 migrations apply AI_DB --remote   # AI database

# Check migration status
npx wrangler d1 migrations list DB --local --env local
npx wrangler d1 migrations list AI_DB --local --env local

# Generate TypeScript types from wrangler.jsonc
npm run cf-typegen

# Generate OpenAPI schema
npm run schema

# Run tests (includes dry-run deployment check)
npm test

# Deploy to Cloudflare (auto-deploys on push to GitHub main)
npm run deploy
```

## Local vs Remote Development

The wrangler.jsonc has two modes:

### Local Mode (recommended for development)
```bash
npx wrangler dev --env local --port 8787
```
- Uses `.dev.vars` for secrets (plain strings)
- Local D1 database (persisted in `.wrangler/state/`)
- All data stored in Cloudflare services (D1, R2, Analytics Engine)

### Default Mode (simulates production)
```bash
npx wrangler dev --port 8787
```
- Uses Secrets Store bindings (objects with `.get()` method)
- Secrets Store doesn't work properly in local dev (returns undefined)
- Use this only when testing Secrets Store integration

### Key Differences

| Feature | `--env local` | Default |
|---------|---------------|---------|
| Secrets | Plain strings from `.dev.vars` | Secrets Store bindings |
| Supabase | Works (uses `.dev.vars`) | Fails ("Supabase not configured") |
| D1 (DB) | Local SQLite in `.wrangler/state/` | Local SQLite |
| D1 (AI_DB) | Local SQLite in `.wrangler/state/` | Local SQLite |
| Best for | Local development | Pre-deploy testing |

### Required `.dev.vars` for Local Mode
```
ENCRYPTION_KEY=<32-byte base64 key>

# OAuth App Credentials (from Google/Meta developer consoles)
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_ADS_DEVELOPER_TOKEN=xxx
FACEBOOK_APP_ID=xxx
FACEBOOK_APP_SECRET=xxx

# OAuth Tunnel - use dev.clearlift.ai for HTTPS callbacks
OAUTH_CALLBACK_BASE=https://dev.clearlift.ai
APP_BASE_URL=http://localhost:3001
```

### Test Data Isolation

- **D1 Database**: Completely isolated - local uses `.wrangler/state/` SQLite, production uses Cloudflare D1
- **Test Org IDs**: Use `test-org-001` pattern locally; production has real UUIDs

## Full Stack Local Testing

### Complete Local Setup (4 Terminals)

```bash
# Terminal 1: API Worker (this repo)
npx wrangler dev --env local --port 8787

# Terminal 2: Queue Consumer (shares D1 with API)
cd ../clearlift-cron && npx wrangler dev \
  --config packages/queue-consumer/wrangler.jsonc \
  --env local --port 8789 \
  --persist-to /Users/work/Documents/Code/clearlift-api/.wrangler/state

# Terminal 3: Dashboard
cd ../clearlift-page-router/apps/dashboard && npm run dev

# Terminal 4: Cloudflare Tunnel (for OAuth - routes dev.clearlift.ai → localhost)
cloudflared tunnel run dev-api
```

### How Local Sync Works

In local mode, Cloudflare Queues don't work between workers (each has isolated mock queues).
The API worker detects local mode and calls the Queue Consumer directly via HTTP:

```
Dashboard → API Worker (8787) → HTTP POST to Queue Consumer (8789) → D1
```

**Key code in `src/endpoints/v1/connectors.ts`:**
```typescript
// LOCAL DEV: Call queue consumer directly (queues don't work locally)
if (isLocal) {
  await fetch('http://localhost:8789/test-sync', {
    method: 'POST',
    body: JSON.stringify(syncJobPayload)
  });
}
```

### ⚠️ D1 State Sharing (Critical)

The Queue Consumer must access the same D1 database as the API:
- API stores encrypted OAuth tokens in `platform_connections`
- API creates sync jobs in `sync_jobs` table
- Queue Consumer reads tokens and updates job status

**Solution:** Use `--persist-to` flag pointing to API's state directory.

**Without it:** Queue Consumer gets `"no such table: sync_jobs"` errors.

### OAuth Testing with dev.clearlift.ai

OAuth providers require HTTPS callback URLs. We use `dev.clearlift.ai` as a permanent Cloudflare tunnel to your local API.

**Setup:**
1. Start the tunnel: `cloudflared tunnel run dev-api`
2. Ensure `.dev.vars` has: `OAUTH_CALLBACK_BASE=https://dev.clearlift.ai`
3. Start the API worker (it picks up the env var)

**Why dev.clearlift.ai:**
- Permanent redirect URIs already registered with OAuth providers (Google, Meta, HubSpot, TikTok)
- No need to update OAuth app settings for each dev session
- Enables remote team collaboration on local builds
- HTTPS endpoints required for OAuth callbacks

**Registered redirect URIs** (already configured in provider consoles):
- `https://dev.clearlift.ai/v1/connectors/google/callback`
- `https://dev.clearlift.ai/v1/connectors/facebook/callback`
- `https://dev.clearlift.ai/v1/connectors/hubspot/callback`
- `https://dev.clearlift.ai/v1/connectors/tiktok/callback`

### Verify Local Sync

1. Health checks:
   ```bash
   curl http://localhost:8787/v1/health  # API
   curl http://localhost:8789/health     # Queue Consumer (should show "database": "ok")
   ```

2. Manual sync test:
   ```bash
   curl -X POST http://localhost:8789/test-sync \
     -H "Content-Type: application/json" \
     -d '{"connection_id":"xxx","platform":"google","account_id":"xxx"}'
   ```

3. Check Supabase for synced data:
   ```bash
   cd ../clearlift-cron && supabase db dump --schema google_ads | head -50
   ```

## Core API Endpoints (To Implement)

### Authentication Middleware Stack
1. Validate Cloudflare Access JWT from headers
2. Extract session token from request
3. Validate session in D1 sessions table
4. Load user and organization context
5. Check organization permissions

### Endpoints

#### GET /me
- Returns current user info + their organizations
- Query: users, organization_members, organizations tables

#### GET /orgs/:orgId/...
- All org-scoped endpoints require membership check
- Use organization_members table to verify access

#### POST /sessions/refresh
- Extend or rotate session tokens
- Update expires_at in sessions table

#### GET /orgs/:orgId/ad/*
- Proxy to Supabase for ad platform data
- Verify org membership before forwarding

#### GET /orgs/:orgId/conversions
- Query Supabase conversions table filtered by org_id
- Returns aggregated conversion data
- No org_tag_mappings needed (uses org_id directly)

## Supabase Schema Reference (CRITICAL)

⚠️ **NEVER query tables without the correct schema prefix!** This has caused bugs where fallback queries silently return empty results.

### Platform Schemas

| Platform | Schema | Tables |
|----------|--------|--------|
| Google Ads | `google_ads` | `campaigns`, `ad_groups`, `ads`, `campaign_daily_metrics`, `ad_group_daily_metrics`, `ad_daily_metrics` |
| Meta/Facebook | `facebook_ads` | `campaigns`, `ad_sets`, `ads`, `campaign_daily_metrics`, `ad_set_daily_metrics`, `ad_daily_metrics` |
| TikTok | `tiktok_ads` | `campaigns`, `ad_groups`, `ads`, `campaign_daily_metrics`, `ad_group_daily_metrics`, `ad_daily_metrics` |
| Unified | `clearlift` | `unified_ad_daily_performance` (materialized view) |
| Stripe | `stripe` | `customers`, `subscriptions`, `payments`, `stripe_conversions` |

### WRONG vs CORRECT queries

```typescript
// ❌ WRONG - No schema, queries non-existent table
await supabase.select('google_campaigns', query);  // ERROR: table not found

// ✅ CORRECT - Use schema option
await supabase.select('campaigns', query, { schema: 'google_ads' });

// ✅ BEST - Use platform adapters
import { GoogleAdsSupabaseAdapter } from "../adapters/platforms/google-supabase";
const adapter = new GoogleAdsSupabaseAdapter(supabase);
const campaigns = await adapter.getCampaignsWithMetrics(orgId, dateRange);
```

### Platform Adapters

Always use platform-specific adapters for data access:

```typescript
import { GoogleAdsSupabaseAdapter } from "../adapters/platforms/google-supabase";
import { FacebookSupabaseAdapter } from "../adapters/platforms/facebook-supabase";
import { TikTokAdsSupabaseAdapter } from "../adapters/platforms/tiktok-supabase";
```

**Key adapter methods:**
- `getCampaigns(orgId)` - Get campaigns
- `getCampaignsWithMetrics(orgId, dateRange)` - Get campaigns with aggregated metrics
- `getCampaignDailyMetrics(orgId, dateRange)` - Get daily performance data

## External Service Integration

### R2 SQL Analytics

```typescript
// Example: Fetching conversion data
import { R2SQLAdapter } from "./adapters/platforms/r2sql";

async function getConversions(orgId: string, c: AppContext) {
  // 1. Get the org's tag
  const mapping = await c.env.DB.prepare(
    "SELECT short_tag FROM org_tag_mappings WHERE organization_id = ?"
  ).bind(orgId).first();

  // 2. Create R2 SQL adapter
  const r2sql = new R2SQLAdapter(
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.R2_BUCKET_NAME,
    c.env.R2_SQL_TOKEN
  );

  // 3. Query events with filters
  const result = await r2sql.getEventsWithSummary(mapping.short_tag, {
    lookback: '24h',
    filters: { eventType: 'conversion' },
    limit: 100
  });

  return result;
}
```

**R2 SQL Limitations:**
- No GROUP BY, DISTINCT, or aggregation functions (COUNT, SUM, AVG)
- Aggregations are performed client-side in the adapter
- Maximum 10,000 rows recommended for aggregation queries

### Supabase Integration

```typescript
// To be implemented - proxy PostgREST API
async function getAdCampaigns(orgId: string) {
  // Verify org access, then proxy to Supabase
  // Implementation depends on Supabase setup
}
```

## Current Implementation

### Example Endpoints (from template)
- `/tasks/*` - CRUD operations using Chanfana's D1 AutoEndpoints
- `/dummy/:slug` - Simple example endpoint
- These can be removed once real endpoints are implemented

### Project Structure
```
src/
  index.ts           # Main router setup with OpenAPI config
  types.ts           # TypeScript type definitions
  endpoints/
    tasks/           # Example CRUD endpoints (to be replaced)
    dummyEndpoint.ts # Example endpoint (to be removed)
  middleware/        # TO CREATE: Auth middleware
  adapters/          # D1, Supabase, R2 SQL adapters
```

## Testing

Tests use Vitest with Cloudflare Workers pool:
- Migrations are applied before tests via `tests/apply-migrations.ts`
- Test database is isolated from production
- Tests run against actual Workers runtime

## Deployment

- **Auto-deployment**: Pushes to GitHub main branch trigger deployment
- **Databases**:
  - Main DB (DB): `89bd84be-b517-4c72-ab61-422384319361`
  - AI DB (AI_DB): `0a8898ef-9ce9-458f-90b9-a89db12c1078`
- **Domain**: api.clearlift.ai (configured in Cloudflare)
- **Important**: After adding new migrations, apply to BOTH databases in production

## AI Analysis Engine

The API worker hosts a hierarchical AI analysis engine that generates insights and recommendations from advertising data.

### Architecture Overview

```
POST /v1/analysis/run
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  EntityTreeBuilder → MetricsFetcher → PromptManager         │
│         │                  │                │               │
│         ▼                  ▼                ▼               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │            HierarchicalAnalyzer                     │    │
│  │                                                     │    │
│  │   Ad → AdSet → Campaign → Account → Cross-Platform  │    │
│  │        (bottom-up analysis with LLM routing)        │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              AgenticLoop (Claude Opus)              │    │
│  │   Tools: set_budget, set_status, set_audience...   │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                  │
│                          ▼                                  │
│               ai_decisions (pending recommendations)        │
└─────────────────────────────────────────────────────────────┘
```

### LLM Provider Routing

Cost-optimized model selection by analysis level:

| Level | Provider | Model | Purpose |
|-------|----------|-------|---------|
| ad | Gemini | `gemini-2.5-flash-lite` | High volume, cheapest |
| adset | Gemini | `gemini-2.5-flash-lite` | High volume |
| campaign | Claude | `claude-haiku-4-5-20251001` | Good synthesis |
| account | Gemini | `gemini-3-pro-preview` | Good aggregation |
| cross_platform | Claude | `claude-opus-4-5-20251101` | Best quality |
| recommendations | Claude | `claude-opus-4-5-20251101` | Agentic tool calling |

Users can override via Settings UI (stored in `ai_optimization_settings.llm_*` columns).

### Key Services (`src/services/analysis/`)

| Service | Purpose |
|---------|---------|
| `entity-tree.ts` | Builds hierarchy from Supabase (campaigns → adsets → ads) |
| `metrics-fetcher.ts` | Fetches timeseries metrics from `*_daily_metrics` tables |
| `prompt-manager.ts` | Template hydration from `analysis_prompts` table |
| `llm-router.ts` | Routes to Claude/Gemini based on level or config |
| `hierarchical-analyzer.ts` | Orchestrates bottom-up analysis |
| `agentic-loop.ts` | Tool-calling loop for recommendations |
| `exploration-tools.ts` | AI exploration tools for verified conversion analysis |
| `anthropic-client.ts` | Claude API integration |
| `gemini-client.ts` | Gemini API integration |

### AI Exploration Tools for Verified Conversions

The AI analysis engine has two tools for analyzing linked/verified conversions:

**`query_conversions_by_goal`**
- Groups verified conversions by goal with confidence scores
- Supports grouping by: day, goal, or link_method
- Returns goal-to-revenue relationships with avg confidence

**`compare_platform_vs_verified_conversions`**
- Compares platform-reported vs verified Stripe/Shopify conversions
- Calculates inflation factor and true ROAS
- Shows link quality breakdown (direct_link, email_hash, time_proximity)
- Essential for understanding if platform data is overstated

### Analysis API Endpoints

```
POST /v1/analysis/run              # Trigger async analysis
GET  /v1/analysis/status/:jobId    # Poll job status
GET  /v1/analysis/latest           # Get most recent analysis
GET  /v1/settings/ai-decisions     # List pending recommendations
POST /v1/settings/ai-decisions/:id/accept   # Execute recommendation
POST /v1/settings/ai-decisions/:id/reject   # Dismiss recommendation
```

## Attribution Analysis Workflow

The API includes a Cloudflare Workflow for computing advanced multi-touch attribution models.

### Architecture

```
┌─────────────────────┐     ┌───────────────────────────┐
│  Dashboard UI       │     │  Attribution Workflow     │
│  "Run Attribution"  │────▶│  (Cloudflare Durable)     │
└─────────────────────┘     └───────────┬───────────────┘
                                        │
                             ┌──────────┴───────────┐
                             ▼                      ▼
                    ┌────────────────┐    ┌─────────────────┐
                    │ Markov Chain   │    │ Shapley Value   │
                    │ Removal Effect │    │ Attribution     │
                    └───────┬────────┘    └────────┬────────┘
                            │                      │
                            ▼                      ▼
                    ┌──────────────────────────────────────┐
                    │   D1: attribution_model_results      │
                    │   (pre-computed credits by channel)  │
                    └──────────────────────────────────────┘
```

### Workflow Steps

1. **fetch_paths** - Query conversion paths from D1 (conversion_attribution table)
2. **markov_chain** - Calculate removal effects using Markov Chain model
3. **shapley_value** - Calculate fair credit using Shapley Value (or Monte Carlo for >10 channels)
4. **store_results** - Write to `attribution_model_results` table with 7-day TTL
5. **complete** - Mark job as completed

### Key Files

| File | Purpose |
|------|---------|
| `src/workflows/attribution-workflow.ts` | Cloudflare Workflow class |
| `src/services/attribution-models.ts` | Core calculation algorithms |
| `src/endpoints/v1/analytics/attribution.ts` | API endpoints |
| `migrations-ai/0004_attribution_model_results.sql` | D1 schema |

### Attribution API Endpoints

```
POST /v1/analytics/attribution/run         # Start workflow (returns job_id)
GET  /v1/analytics/attribution/status/:id  # Poll job status
GET  /v1/analytics/attribution/computed    # Get pre-computed results by model
GET  /v1/analytics/attribution             # Main attribution endpoint (reads from pre-computed)
```

### Data Quality Levels

The attribution endpoint returns a `data_quality` field with quality assessment:

| Quality | Description | Requirements |
|---------|-------------|--------------|
| `verified` | Conversions linked to goals with high confidence | ≥10 verified conversions, ≥70% avg confidence, ≥50% verification rate |
| `connector_only` | Using Stripe/Shopify data without goal linking | Has connector conversions but not linked to goals |
| `tracked` | Using tag event data | Has tag events with conversions |
| `estimated` | Mixed data quality | Partial data available |
| `platform_reported` | Ad platform self-reported data only | No verified/tracked conversions |

When quality is `verified` or `connector_only`, the response includes verification metrics:

```json
{
  "data_quality": {
    "quality": "verified",
    "verification": {
      "verified_conversion_count": 47,
      "avg_link_confidence": 0.85,
      "link_method_breakdown": { "direct_link": 12, "email_hash": 28, "time_proximity": 7 },
      "verification_rate": 78.3
    }
  }
}
```

### Models

**Markov Chain Attribution:**
- Calculates "removal effect" - how much conversion rate drops when a channel is removed
- Accounts for channel order and transitions
- Fast computation, works well for any dataset size

**Shapley Value Attribution:**
- Game theory approach for fair credit distribution
- Exact computation for ≤10 channels (O(2^n))
- Monte Carlo approximation for >10 channels (5000 samples)
- Most mathematically rigorous but computationally expensive

**Daily Time-Decay Distribution (Smart Attribution):**
- Distributes connector revenue (Stripe/Shopify) across UTM channels using temporal proximity
- 2-day half-life, 7-day lookback window
- Falls back to flat session-share when insufficient data (< 2 conversion days)
- See `computeDailyTimeDecayDistribution()` in `smart-attribution.ts`

### User-Configurable LLM Settings

Stored in `ai_optimization_settings` table:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `llm_default_provider` | TEXT | 'auto' | 'auto', 'claude', or 'gemini' |
| `llm_claude_model` | TEXT | 'haiku' | 'opus', 'sonnet', 'haiku' |
| `llm_gemini_model` | TEXT | 'flash' | 'pro', 'flash', 'flash_lite' |
| `llm_max_recommendations` | INTEGER | 3 | Max recommendations per run |
| `llm_enable_exploration` | INTEGER | 1 | Enable exploration tools |
| `custom_instructions` | TEXT | NULL | Business context for LLM |

---

## Cross-Repo Shared Code

This codebase contains **canonical implementations** of shared logic used across the ClearLift platform.

### Full Documentation

See **`clearlift-cron/docs/SHARED_CODE.md`** for comprehensive cross-repo code sharing documentation covering 15 shared concepts.

### Canonical Sources (This Repo)

| Concept | File | SHARED_CODE Section |
|---------|------|---------------------|
| Attribution Models | `src/services/attribution-models.ts` | §1 Attribution Models |
| Platform/UTM Mapping | `src/services/smart-attribution.ts` | §2 Platform/UTM Mapping |
| Daily Time-Decay Distribution | `src/services/smart-attribution.ts` | §19.9d Time-Decay |
| Markov Chain | `src/services/attribution-models.ts` | §4 Markov Chain |
| Shapley Value | `src/services/attribution-models.ts` | §1 Attribution Models |
| Stage Markov | `src/services/stage-markov.ts` | §4 Markov Chain |
| ConversionGoal Types | `src/services/goals/index.ts` | §6 Conversion Goals |
| OAuth Base Provider | `src/services/oauth/base.ts` | §9 OAuth Base |
| API Response Types | `src/types/response.ts` | §10 API Response Types |
| Auth Utilities | `src/utils/auth.ts` | §11 Auth Utilities |
| Platform Constants | `src/constants/facebook.ts`, `tiktok.ts` | §12 Platform Constants |

### Derived Implementations (From clearlift-cron)

| Concept | Canonical Source | Notes |
|---------|-----------------|-------|
| Field Encryption | `clearlift-cron/shared/utils/crypto.ts` | Cron is canonical (better error handling) |

### Time Decay Algorithms (Canonical)

**Touchpoint-level time decay** (attribution models):
```typescript
// 7-day half-life - touchpoints lose half their credit every 7 days
const daysBeforeConversion = (conversionTime - touchpointTime) / MS_PER_DAY;
const weight = Math.pow(0.5, daysBeforeConversion / 7);
```

**Daily session-to-conversion time decay** (Smart Attribution, `computeDailyTimeDecayDistribution()`):
```typescript
// 2-day half-life, 7-day lookback — distributes connector revenue across UTM channels
const weight = Math.exp(-daysBack * Math.LN2 / 2);
// Sessions closer to conversion day get exponentially more credit
// Replaces flat session-share when ≥2 conversion days + UTM data exist
// Uses dailyUtmPerformance + dailyConnectorRevenue (already queried, no new D1 calls)
```

See `SHARED_CODE.md §19.9d` for full algorithm details, data sources, and why hourly resolution was rejected.

### When Modifying Shared Logic

1. **Check SHARED_CODE.md** for canonical source
2. **Update canonical first** - Make changes in the canonical location
3. **Propagate to derived** - Update derived implementations
4. **Test across repos**:
   ```bash
   cd ../clearlift-api && npx tsc --noEmit
   cd ../clearlift-cron/packages/queue-consumer && npx tsc --noEmit
   ```
5. **Document changes** - Update SHARED_CODE.md if adding new shared concepts

---

## Important Context

- Test session token: `00000000-test-1234-0000-000000000000` (for testing)
- All endpoints should return consistent error format per Chanfana conventions
- The worker serves as the single authentication point for all client applications
- Organization access is determined by organization_members table, not by tags
- Tags are only used for data partitioning in the analytics system

---

## Project Completion Status

**Last Updated:** January 2026

See `clearlift-cron/docs/SHARED_CODE.md §19` for the comprehensive cross-repo implementation details.

### Migrations Created

| Migration | Purpose | Status |
|-----------|---------|--------|
| `0017_add_conversion_linking.sql` | Adds linking columns to conversions table | ✅ Created |
| `0018_journey_analytics_table.sql` | Creates journey_analytics table | ✅ Created |

**Note:** `customer_identities` already existed in migration 0014. `shopify_orders` already existed in migration 0006.

### Backend Workflows (clearlift-cron)

The following workflows are now implemented:

| Workflow | Purpose | Status |
|----------|---------|--------|
| `IdentityExtractionWorkflow` | Populates `customer_identities` from Stripe + tag events | ✅ Implemented |
| `ConversionLinkingWorkflow` | Links Stripe/Shopify conversions to tag goals | ✅ Implemented |
| Shopify sync/aggregation | Writes to `shopify_orders` and `conversions` tables | ✅ Enabled |

### Verification Queries

After workflows run, verify data flow:

```sql
-- Verify customer identities populated
SELECT COUNT(*) FROM customer_identities;

-- Verify journey analytics populated
SELECT COUNT(*) FROM journey_analytics WHERE converting_sessions > 0;

-- Verify conversion linking working
SELECT link_method, COUNT(*), AVG(link_confidence)
FROM conversions
WHERE linked_goal_id IS NOT NULL
GROUP BY link_method;

-- Verify Shopify orders synced
SELECT COUNT(*) FROM shopify_orders;
```

---

## Connector System & Gaps

### Current Active Connectors

| Connector | Type | Sync |
|-----------|------|------|
| Google Ads | Ad Platform | D1 every 15 min |
| Meta Ads | Ad Platform | D1 every 15 min |
| TikTok Ads | Ad Platform | D1 every 15 min |
| Stripe | Revenue | D1 every 15 min |
| Shopify | Revenue | D1 every 15 min |
| Jobber | Revenue | D1 every 15 min |

### Vertical Coverage Summary

- ✅ **Full:** E-commerce, SaaS (direct), Marketplaces
- ⚠️ **Partial:** B2B SaaS, Local Services, Lead Gen (missing CRM/phone)
- ❌ **None:** Mobile Apps, Local Businesses

### Connector Roadmap

| Phase | Connectors | Impact |
|-------|------------|--------|
| **1 (CRM)** | HubSpot, Salesforce | Unlocks B2B SaaS, Lead Gen |
| **2 (Comms)** | CallRail, Calendly | Unlocks Local Services |
| **3 (Ads)** | LinkedIn Marketing | Better B2B attribution |
| **4 (Creator)** | ConvertKit, Kajabi | Niche verticals |

### HubSpot Integration Status (Feb 2026)

**Implementation Status:**

| Component | Status | File |
|-----------|--------|------|
| OAuth Provider | ✅ Implemented | `src/services/oauth/hubspot.ts` |
| Webhook Handler | ✅ Implemented | `src/endpoints/v1/webhooks/handlers.ts` |
| Wrangler Bindings | ✅ Configured | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` |
| Secrets in Cloudflare | ✅ Set | Secret Store bindings in wrangler.jsonc |
| CRM connector + pagination | ✅ Implemented | `clearlift-cron` HubSpot adapter |
| Connector registered | ✅ Active | `register.ts` isActive: true |
| Type errors fixed | ✅ Fixed | `hubspot-adapter.ts` config, `crm-sync.ts` LifecycleStage |
| API CRM query pagination | ⚠️ Missing | API endpoints need pagination for CRM data |

**HubSpot OAuth is ready.** Secrets configured via Secret Store bindings (`HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`) in wrangler.jsonc.

**Remaining blocker:** API CRM query endpoints need pagination for production-scale data.

**HubSpot CLI for Development:**

The `hs` CLI (v7.11.3) is configured with account `clear-lift` (244951827).

```bash
# Create development sandbox (isolated test data)
hs sandbox create --name="clearlift-dev"

# Check account info
hs account info

# Manage secrets
hs app secret list
```

Use sandboxes for testing OAuth flows and sync without affecting production HubSpot data.

### Architecture Notes for New Connectors

All connectors should implement:
- OAuth or API key authentication
- `fetchData()` for sync
- `writeToD1()` for storage
- `extractIdentities()` for attribution linking
- `matchGoals()` for conversion linking

See `clearlift-cron/docs/SHARED_CODE.md §20` for full roadmap.

---

## Infrastructure Improvements (January 2026)

Five foundational backend improvements enabling the UI overhaul and scaling to 100+ connectors.

### New Services

| Service | File | Purpose |
|---------|------|---------|
| FunnelGraphService | `src/services/funnel-graph.ts` | OR/AND funnel branching, path validation |
| ConversionValueService | `src/services/conversion-value.ts` | Multi-goal value allocation |
| GoalGroupService | `src/services/conversion-value.ts` | Goal group management |

### New Migrations

| Migration | Purpose |
|-----------|---------|
| `0071_add_webhook_endpoints.sql` | Webhook ingestion infrastructure |
| `0072_add_funnel_branching.sql` | OR/AND relationships, flow tags, branch points |
| `0073_add_multi_conversion.sql` | Goal groups, value allocations |

### Webhook Ingestion (Phase 2)

**New Tables:**
- `webhook_endpoints` - Endpoint configuration per org/connector
- `webhook_events` - Incoming events with deduplication
- `webhook_delivery_log` - Delivery attempt tracking

**Endpoints:**
- `POST /v1/webhooks/:connector/:event` - Receive webhooks
- `GET/POST/DELETE /v1/webhooks` - Manage endpoints
- `GET /v1/webhooks/:id/events` - Get events

**Handlers:** `src/endpoints/v1/webhooks/handlers.ts`
- StripeWebhookHandler - Stripe signature verification
- ShopifyWebhookHandler - HMAC verification
- HubSpotWebhookHandler - v1/v3 signature verification

### Funnel Branching (Phase 4)

**New Columns on `goal_relationships`:**
- `relationship_operator` - 'OR' or 'AND'
- `flow_tag` - Tags like 'self_serve', 'sales_led'
- `is_exclusive` - Mutually exclusive paths

**New Tables:**
- `goal_branches` - Branch points (split/join)
- `acquisition_instances` - Traffic source instances
- `conversion_configs` - Conversion event configuration

**Endpoints:**
- `GET /v1/goals/graph` - Full funnel graph for Flow Builder
- `POST /v1/goals/relationships/v2` - Create with OR/AND
- `POST /v1/goals/branch` - Create split point
- `POST /v1/goals/merge` - Create join point
- `GET /v1/goals/paths` - Valid paths to a goal

### Multi-Conversion (Phase 5)

**New Tables:**
- `goal_groups` - Logical groupings (e.g., "All Revenue Events")
- `goal_group_members` - Maps goals to groups with weights
- `conversion_value_allocations` - Tracks value distribution

**New Columns on `conversions`:**
- `goal_ids` - JSON array of matched goals
- `goal_values` - JSON object: {goal_id: value_cents}
- `attribution_group_id` - Link to goal group

**Endpoints:**
- `GET/POST /v1/goals/groups` - List/create groups
- `GET/PUT /v1/goals/groups/:id/members` - Manage members
- `POST /v1/goals/groups/:id/default` - Set default attribution
- `DELETE /v1/goals/groups/:id` - Delete group

**Allocation Methods:**
- `equal` - Split evenly across matched goals
- `weighted` - Use weights from goal_group_members
- `explicit` - Use each goal's fixed_value_cents

See `clearlift-cron/docs/SHARED_CODE.md §24` for complete documentation.

---

## Connector Registry

**Status:** ✅ Implemented (January 2026)

The connector registry provides dynamic connector definitions loaded from D1 instead of hardcoded values.

### Endpoint

```
GET /v1/connectors/registry
```

Returns all connector definitions with their:
- Events schema (available event types + fields)
- Icon metadata (name, color)
- Category and type classifications
- Active/beta status

### Type Definitions

**Location:** `src/services/connector-registry.ts`

```typescript
// 16 connector types
export type ConnectorType =
  | 'ad_platform' | 'crm' | 'communication' | 'ecommerce' | 'payments'
  | 'support' | 'scheduling' | 'forms' | 'events' | 'analytics'
  | 'accounting' | 'attribution' | 'reviews' | 'affiliate' | 'social'
  | 'field_service';

// 12 UI grouping categories
export type ConnectorCategory =
  | 'advertising' | 'sales' | 'marketing' | 'commerce' | 'operations'
  | 'analytics' | 'finance' | 'communication' | 'ecommerce' | 'payments'
  | 'crm' | 'field_service';
```

### Migration

**File:** `migrations/0069_seed_extended_connectors.sql`

Seeds 25+ connector definitions across 15 categories:
- **CRM:** HubSpot, Salesforce, Pipedrive
- **Communication:** Klaviyo, Mailchimp, Attentive
- **Support:** Zendesk, Intercom
- **Scheduling:** Calendly, Acuity
- **Forms:** Typeform, JotForm
- **Accounting:** QuickBooks, Xero
- **Attribution:** AppsFlyer, Adjust
- **Reviews:** G2, Trustpilot
- **Affiliate:** Impact, PartnerStack
- **Social:** LinkedIn Pages, Instagram Business
- **Payments:** Lemon Squeezy, Paddle, Chargebee, Recurly
- **Ad Platform:** LinkedIn Ads

New connectors are seeded with `is_active: false, is_beta: true` until sync handlers are implemented.

### Known Issues (Jan 2026)

**Google Ads — Unagi (org `125da223`): 0 records syncing**
- Account `4417684447` is likely a manager account
- Connection settings are `{"sync_config":{"timeframe":"all_time"}}` — missing `accountSelection` config
- Sync completes successfully but writes 0 campaigns/metrics to `ad_campaigns`/`ad_metrics`
- Stale `sync_error: "OAuth token refresh failed with status 400"` from past failure; token is currently valid
- Fix: Add `{"accountSelection":{"mode":"all"}}` to settings, or identify and select child accounts

### Dashboard Integration

The Flow Builder now uses `ConnectorRegistryContext` instead of the deprecated `CONNECTOR_EVENTS` constant. This enables:
- Dynamic connector discovery from the API
- SSR fallback with 25+ FALLBACK_CONNECTORS
- Grouped dropdown UI (Connected / Available to Connect / Coming Soon)