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

| Binding | Database Name | Purpose |
|---------|--------------|---------|
| `ANALYTICS_DB` | clearlift-analytics-dev | Aggregated metrics, attribution, journeys |

**Tables:**
- `hourly_metrics`, `daily_metrics` - Pre-aggregated event metrics
- `utm_performance` - UTM campaign attribution
- `attribution_results` - Multi-touch attribution
- `journeys`, `channel_transitions` - Customer journey analysis
- `google_campaigns`, `facebook_campaigns`, `tiktok_campaigns` - Platform data (sync'd from queue-consumer)

#### D1 Sharding Infrastructure (SHARD_0-3)

Four shard databases for scaling platform data by organization:

| Binding | Database Name | Purpose |
|---------|--------------|---------|
| `SHARD_0` | clearlift-shard-0 | Org data (hash % 4 == 0) |
| `SHARD_1` | clearlift-shard-1 | Org data (hash % 4 == 1) |
| `SHARD_2` | clearlift-shard-2 | Org data (hash % 4 == 2) |
| `SHARD_3` | clearlift-shard-3 | Org data (hash % 4 == 3) |

**Routing:** Uses `ShardRouter` with FNV-1a consistent hashing. See `src/services/shard-router.ts`.

**Migration status:** Tracked in `shard_routing` table (per-org `read_source` and `write_mode`).

#### Data Sources Summary

| Data Type | Storage | Query Layer | Notes |
|-----------|---------|-------------|-------|
| Real-time events | Analytics Engine | `/v1/analytics/realtime/*` | Sub-second queries |
| Event aggregations | D1 ANALYTICS_DB | `/v1/analytics/d1/*` | Pre-aggregated metrics |
| Platform campaigns | D1 Shards | `/v1/analytics/platforms` | Sharded by org |
| Platform metrics | D1 Shards | `/v1/analytics/platforms` | Sharded by org |
| Raw events (archive) | R2 SQL | `/v1/analytics/events` | 15-25s queries |

#### Other Data Sources
1. **Analytics Engine** - Real-time event analytics with < 100ms latency (90-day retention)
2. **R2 SQL** - Historical event archive beyond 90 days (Iceberg tables)

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

# OAuth Tunnel (update each time cloudflared restarts)
OAUTH_CALLBACK_BASE=https://xxx-xxx-xxx.trycloudflare.com
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

# Terminal 4: Cloudflared Tunnel (for OAuth)
cloudflared tunnel --url http://localhost:8787
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

### OAuth Testing with Cloudflared

1. Start cloudflared: `cloudflared tunnel --url http://localhost:8787`
2. Copy the generated URL (e.g., `https://xxx.trycloudflare.com`)
3. Update `.dev.vars`:
   ```
   OAUTH_CALLBACK_BASE=https://xxx.trycloudflare.com
   ```
4. Update Google Cloud Console / Meta Developer Console redirect URIs
5. Restart API worker

**Note:** Cloudflared URLs change each restart. You must update both `.dev.vars` and the OAuth provider consoles.

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
| `anthropic-client.ts` | Claude API integration |
| `gemini-client.ts` | Gemini API integration |

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

### Time Decay Algorithm (Canonical)

```typescript
// 7-day half-life - touchpoints lose half their credit every 7 days
const daysBeforeConversion = (conversionTime - touchpointTime) / MS_PER_DAY;
const weight = Math.pow(0.5, daysBeforeConversion / 7);
```

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

## Project Completion Roadmap

This section documents remaining work to fully wire the ClearLift platform. See `clearlift-cron/docs/SHARED_CODE.md §19` for the comprehensive cross-repo roadmap.

### Migrations Required (This Repo)

Create these new migrations in `migrations-analytics/`:

#### 1. `0015_add_conversion_linking.sql`

Adds columns to link Stripe conversions to tag goals:

```sql
ALTER TABLE conversions ADD COLUMN linked_goal_id TEXT;
ALTER TABLE conversions ADD COLUMN link_confidence REAL DEFAULT 1.0;
ALTER TABLE conversions ADD COLUMN link_method TEXT;
ALTER TABLE conversions ADD COLUMN linked_at TEXT;

CREATE INDEX idx_conversions_unlinked ON conversions(linked_goal_id) WHERE linked_goal_id IS NULL;
```

#### 2. `0016_customer_identities.sql`

Enables email-based attribution matching:

```sql
CREATE TABLE IF NOT EXISTS customer_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  anonymous_id TEXT,
  session_id TEXT,
  device_fingerprint_id TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(organization_id, email_hash)
);
```

#### 3. `0017_journey_analytics.sql`

Stores computed journey data for dashboard:

```sql
CREATE TABLE IF NOT EXISTS journey_analytics (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  channel_path TEXT NOT NULL,
  path_length INTEGER NOT NULL,
  has_conversion INTEGER DEFAULT 0,
  conversion_count INTEGER DEFAULT 0,
  total_value_cents INTEGER DEFAULT 0,
  first_touch_channel TEXT,
  last_touch_channel TEXT,
  attribution_model_credits TEXT,
  computed_at TEXT NOT NULL,
  UNIQUE(organization_id, journey_id)
);
```

#### 4. `0018_shopify_tables.sql`

Enables Shopify order sync:

```sql
CREATE TABLE IF NOT EXISTS shopify_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  customer_email_hash TEXT,
  total_price_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  financial_status TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  note_attributes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, shopify_order_id)
);
```

### API Changes Required

#### 1. Attribution Endpoint Updates

**File:** `src/endpoints/v1/analytics/attribution.ts`

The `GetJourneyAnalytics` endpoint (line ~2212) currently queries an empty table. After `journey_analytics` is populated by clearlift-cron, verify the query works:

```typescript
// Should return data after probabilistic attribution workflow runs
const journeys = await env.ANALYTICS_DB.prepare(`
  SELECT * FROM journey_analytics
  WHERE organization_id = ?
  ORDER BY computed_at DESC
  LIMIT 100
`).bind(orgId).all();
```

#### 2. Unified Conversions View

Add a new endpoint or update existing attribution endpoint to use the unified view:

```typescript
// New helper in attribution.ts
async function getUnifiedConversions(orgId: string, startDate: string, endDate: string) {
  return env.ANALYTICS_DB.prepare(`
    SELECT * FROM unified_conversions
    WHERE organization_id = ?
      AND conversion_timestamp >= ?
      AND conversion_timestamp < ?
  `).bind(orgId, startDate, endDate).all();
}
```

### Workflow Updates Required

#### Attribution Workflow Data Source

**File:** `src/workflows/attribution-workflow.ts`

Currently reads from `conversion_attribution` table. After conversion linking is implemented, update to read from `unified_conversions`:

```typescript
// Step 1: fetch_paths - update query
const paths = await env.ANALYTICS_DB.prepare(`
  SELECT
    uc.organization_id,
    uc.goal_id,
    uc.value_cents,
    ja.channel_path,
    ja.first_touch_channel,
    ja.last_touch_channel
  FROM unified_conversions uc
  JOIN journey_analytics ja ON uc.organization_id = ja.organization_id
    AND uc.anonymous_id = ja.anonymous_id
  WHERE uc.organization_id = ?
    AND uc.conversion_timestamp >= datetime('now', '-30 days')
`).bind(orgId).all();
```

### Verification After Implementation

Run these queries to verify migrations and data flow:

```sql
-- After applying migrations
.tables  -- Should show: customer_identities, journey_analytics, shopify_orders

-- After clearlift-cron identity extraction runs
SELECT COUNT(*) FROM customer_identities;  -- Should be > 0

-- After clearlift-cron probabilistic attribution runs
SELECT COUNT(*) FROM journey_analytics WHERE has_conversion = 1;  -- Should be > 0

-- After conversion linking workflow runs
SELECT link_method, COUNT(*) FROM conversions
WHERE linked_goal_id IS NOT NULL
GROUP BY link_method;  -- Should show 'direct', 'email_hash', 'time_proximity'
```

### Dependencies

This repo depends on clearlift-cron workflows to populate:
- `customer_identities` (IdentityExtractionWorkflow)
- `journey_analytics` (ProbabilisticAttributionWorkflow)
- `conversions.linked_goal_id` (ConversionLinkingWorkflow)

Coordinate with clearlift-cron implementation. See `SHARED_CODE.md §19` for workflow pseudocode.