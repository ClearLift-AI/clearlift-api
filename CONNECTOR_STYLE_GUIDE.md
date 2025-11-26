# ClearLift Connector Style Guide

**Version:** 1.0
**Last Updated:** 2025-11-24
**Audience:** Engineers building new data connectors for the ClearLift platform

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Component Breakdown](#component-breakdown)
3. [Adding a New Connector: Step-by-Step](#adding-a-new-connector-step-by-step)
4. [API Worker Components](#api-worker-components)
5. [Cron Worker Components](#cron-worker-components)
6. [Complete Example: Shopify Orders](#complete-example-shopify-orders)
7. [Testing & Deployment](#testing--deployment)
8. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

ClearLift uses a **three-worker architecture** for data ingestion and access:

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER APPLICATION                          │
│                  (Frontend, Mobile, Integrations)                │
└─────────────────────┬────────────────────────────────────────────┘
                      │ HTTP Requests
                      ↓
┌─────────────────────────────────────────────────────────────────┐
│                    API WORKER (clearlift-api)                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  RESPONSIBILITIES:                                        │  │
│  │  1. OAuth initiation & token exchange                     │  │
│  │  2. Store encrypted tokens in D1                          │  │
│  │  3. Create sync jobs → Queue                              │  │
│  │  4. Read data from Supabase via adapters                  │  │
│  │  5. Expose data via REST endpoints                        │  │
│  │                                                            │  │
│  │  COMPONENTS:                                               │  │
│  │  • src/endpoints/v1/connectors.ts (OAuth endpoints)       │  │
│  │  • src/endpoints/v1/analytics/{platform}.ts (Data APIs)   │  │
│  │  • src/adapters/platforms/{platform}-supabase.ts          │  │
│  │  • src/services/oauth/{platform}.ts (OAuth providers)     │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────┬──────────────────────────────────┬─────────────────────┘
         │ Creates Sync Job                 │ Reads Data
         ↓                                  ↓
┌────────────────────┐           ┌──────────────────────┐
│ Cloudflare Queue   │           │     Supabase         │
│   (SYNC_QUEUE)     │           │    PostgreSQL        │
└────────┬───────────┘           │  • google_ads.*      │
         │                        │  • facebook_ads.*    │
         ↓                        │  • stripe.*          │
┌─────────────────────────────────────────────────────────────────┐
│                  CRON WORKER (clearlift-cron)                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  RESPONSIBILITIES:                                        │  │
│  │  1. Process sync jobs from queue                          │  │
│  │  2. Decrypt OAuth tokens from D1                          │  │
│  │  3. Fetch data from external platform APIs                │  │
│  │  4. Transform data to standard format                     │  │
│  │  5. Write data to Supabase (platform-specific schemas)    │  │
│  │  6. Update job status & audit logs                        │  │
│  │                                                            │  │
│  │  COMPONENTS:                                               │  │
│  │  • packages/queue-consumer/src/connectors/{platform}.ts   │  │
│  │  • packages/queue-consumer/src/services/supabase.ts       │  │
│  │  • packages/queue-consumer/src/index.ts (queue handler)   │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────┬──────────────────────────────────────────────────────────┘
         │ Writes Data
         ↓
┌──────────────────────┐
│     Supabase         │
│    PostgreSQL        │
│  • google_ads.*      │
│  • facebook_ads.*    │
│  • stripe.*          │
│  • shopify.*  ← NEW! │
└──────────────────────┘
```

### Data Flow Example

1. **User connects Shopify** via frontend
2. **API Worker** initiates OAuth flow → user authorizes
3. **API Worker** receives OAuth callback, exchanges code for token
4. **API Worker** encrypts token, stores in `platform_connections` table (D1)
5. **API Worker** creates sync job, sends to `SYNC_QUEUE`
6. **Cron Worker** receives message from queue
7. **Cron Worker** fetches encrypted token from D1, decrypts
8. **Cron Worker** calls Shopify connector
9. **ShopifyConnector** fetches orders from Shopify API
10. **ShopifyConnector** transforms data to standard format
11. **Cron Worker** writes data to `shopify.orders` table in Supabase
12. **Cron Worker** updates job status, writes audit log
13. **User requests data** via frontend
14. **API Worker** queries `shopify.orders` via **ShopifySupabaseAdapter**
15. **API Worker** returns data to user

---

## Component Breakdown

When adding a new connector (e.g., Shopify), you must implement **7 components** across **2 repositories**:

### API Worker (`clearlift-api`) - 4 Components

| Component | File Path | Purpose |
|-----------|-----------|---------|
| **1. OAuth Provider** | `src/services/oauth/shopify.ts` | OAuth 2.0 flow implementation |
| **2. Supabase Adapter** | `src/adapters/platforms/shopify-supabase.ts` | Read data from Supabase `shopify.*` schema |
| **3. Analytics Endpoints** | `src/endpoints/v1/analytics/shopify.ts` | REST API endpoints to expose data |
| **4. OAuth Endpoints** | `src/endpoints/v1/connectors.ts` | Add Shopify to OAuth initiation (minor update) |

### Cron Worker (`clearlift-cron`) - 3 Components

| Component | File Path | Purpose |
|-----------|-----------|---------|
| **5. Platform Connector** | `packages/queue-consumer/src/connectors/shopify.ts` | Fetch data from Shopify API |
| **6. Supabase Write Methods** | `packages/queue-consumer/src/services/supabase.ts` | Write methods for `shopify.*` tables |
| **7. Queue Handler Integration** | `packages/queue-consumer/src/index.ts` | Route sync jobs to Shopify connector |

---

## Best Practices Summary

### API Worker

1. **Always verify org access** in endpoints
2. **Use Supabase adapters** for data access (never raw SQL)
3. **Return consistent error format** (`success`, `error`, `data` fields)
4. **Cache Supabase client** when possible

### Cron Worker

1. **Use `fetchWithTimeout()`** for all HTTP requests
2. **Throw `RateLimitError` on 429** responses
3. **Implement pagination safety** limits
4. **Transform currency to cents** (no floating point)
5. **Hash PII** (emails, phone numbers)
6. **Store raw_data** for debugging


