# Cron Worker Deployment Guide

**ClearLift Multi-Connector Data Sync Platform - Cron Worker Implementation**

---

## Table of Contents

1. [Overview](#overview)
2. [Part 1: Understanding the Deployed System](#part-1-understanding-the-deployed-system)
3. [Part 2: Cron Worker Architecture](#part-2-cron-worker-architecture)
4. [Part 3: Implementation Guide](#part-3-implementation-guide)
5. [Part 4: Deployment](#part-4-deployment)
6. [Part 5: Testing](#part-5-testing)
7. [Part 6: Monitoring](#part-6-monitoring)

---

## Overview

### 3-Worker Architecture

ClearLift uses a distributed architecture with three specialized Cloudflare Workers:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER FLOW                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│  1. API WORKER (✅ DEPLOYED)                                       │
│     - User-facing REST API                                         │
│     - OAuth flow handling                                          │
│     - Credential storage (encrypted in D1)                         │
│     - Onboarding state management                                  │
│     - Session authentication                                       │
│                                                                     │
│  Endpoints:                                                        │
│  • GET  /v1/onboarding/status                                      │
│  • POST /v1/connectors/:provider/connect                           │
│  • GET  /v1/connectors/:provider/callback                          │
│  • GET  /v1/connectors/connected                                   │
│  • DELETE /v1/connectors/:connection_id                            │
└────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Stores encrypted credentials
                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│                      CLOUDFLARE D1 DATABASE                        │
│                                                                     │
│  Tables:                                                           │
│  • platform_connections (with encrypted tokens)                    │
│  • onboarding_progress                                             │
│  • sync_jobs                                                       │
│  • connector_configs                                               │
└────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Reads active connections
                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│  2. CRON WORKER (⏳ TO BE DEPLOYED)                                │
│     - Runs every 15 minutes (scheduled trigger)                    │
│     - Queries D1 for active platform connections                   │
│     - Checks if sync is needed (based on last_synced_at)          │
│     - Refreshes expired OAuth tokens                               │
│     - Creates sync_jobs records                                    │
│     - Enqueues messages to Cloudflare Queue                        │
│                                                                     │
│  Responsibilities:                                                 │
│  • Find connections due for sync                                   │
│  • Handle token refresh (Google, Facebook, etc.)                   │
│  • Create job records in sync_jobs table                           │
│  • Send messages to queue                                          │
└────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Sends job messages
                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE QUEUE                                │
│                    (sync-jobs queue)                               │
└────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Delivers messages
                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│  3. QUEUE CONSUMER WORKER (⏳ FUTURE)                              │
│     - Consumes messages from sync-jobs queue                       │
│     - Executes actual API calls to platforms                       │
│     - Fetches data from Google Ads, Facebook Ads, Stripe, etc.    │
│     - Writes synced data to Supabase PostgreSQL                    │
│     - Updates sync_jobs status and last_synced_at                  │
│     - Marks onboarding first_sync_completed = true                 │
│                                                                     │
│  Responsibilities:                                                 │
│  • Execute platform API calls                                      │
│  • Transform and validate data                                     │
│  • Write to Supabase (ad_campaigns, ad_metrics tables)            │
│  • Update job status                                               │
│  • Trigger onboarding progression                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Current State

**✅ Completed (API Worker):**
- User authentication and session management
- OAuth 2.0 flows (Google, Facebook)
- Encrypted credential storage in D1
- Onboarding state tracking with auto-progression
- 9 REST API endpoints deployed at `api.clearlift.ai`

**⏳ This Guide (Cron Worker):**
- Scheduled job creation every 15 minutes
- Active connection discovery
- Token refresh management
- Queue message generation

**🔜 Future (Queue Consumer):**
- Actual data syncing from platforms
- Supabase data storage
- Job status updates

---

## Part 1: Understanding the Deployed System

### Database Schema (Cloudflare D1)

The API Worker has already created these tables in production D1:

#### 1. `platform_connections` - Active OAuth connections

```sql
CREATE TABLE platform_connections (
    id TEXT PRIMARY KEY,                    -- Format: {org_id}-{platform}-{account_id}
    organization_id TEXT NOT NULL,
    platform TEXT NOT NULL,                 -- 'google', 'facebook', 'tiktok', 'stripe'
    account_id TEXT NOT NULL,               -- Platform's account ID
    account_name TEXT,                      -- Display name
    connected_by TEXT NOT NULL,             -- User ID who connected
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME,                -- ⚠️ Cron Worker updates this
    sync_status TEXT DEFAULT 'pending',     -- 'pending'|'syncing'|'completed'|'failed'
    sync_error TEXT,
    is_active BOOLEAN DEFAULT TRUE,

    -- Encrypted credentials (AES-256-GCM)
    credentials_encrypted TEXT,             -- Encrypted access token
    refresh_token_encrypted TEXT,           -- Encrypted refresh token
    expires_at DATETIME,                    -- Token expiration
    scopes TEXT,                            -- JSON array of granted scopes

    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    UNIQUE(organization_id, platform, account_id)
);
```

**Key fields for Cron Worker:**
- `is_active = 1` → Include in sync schedule
- `last_synced_at` → Determine if sync is due
- `expires_at` → Check if token needs refresh
- `credentials_encrypted` → Decrypt to get access token
- `refresh_token_encrypted` → Use for token refresh

#### 2. `sync_jobs` - Job tracking

```sql
CREATE TABLE sync_jobs (
    id TEXT PRIMARY KEY,                    -- UUID
    organization_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,            -- FK to platform_connections
    status TEXT DEFAULT 'pending',          -- 'pending'|'running'|'completed'|'failed'
    job_type TEXT DEFAULT 'full',           -- 'full'|'incremental'
    started_at DATETIME,
    completed_at DATETIME,
    error_message TEXT,
    records_synced INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT DEFAULT '{}',             -- JSON for sync details

    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    FOREIGN KEY (connection_id) REFERENCES platform_connections(id)
);
```

**Cron Worker creates records here** before enqueueing jobs.

#### 3. `onboarding_progress` - User onboarding state

```sql
CREATE TABLE onboarding_progress (
    user_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    current_step TEXT NOT NULL,             -- 'welcome'|'connect_services'|'first_sync'|'completed'
    steps_completed TEXT DEFAULT '[]',
    services_connected INTEGER DEFAULT 0,   -- Auto-increments on connection
    first_sync_completed BOOLEAN DEFAULT FALSE,  -- ⚠️ Queue Consumer sets this
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);
```

**Onboarding Flow:**
1. User connects first platform → `services_connected++` → advances to `first_sync` step
2. Cron creates sync job → Queue Consumer executes → marks `first_sync_completed = TRUE`
3. OnboardingService auto-advances to `completed` step

#### 4. `connector_configs` - Platform definitions

```sql
-- Pre-seeded with 4 connectors:
INSERT INTO connector_configs (provider, name, auth_type, oauth_authorize_url, oauth_token_url, oauth_scopes) VALUES
  ('google', 'Google Ads', 'oauth2', 'https://accounts.google.com/o/oauth2/v2/auth', ...),
  ('facebook', 'Facebook Ads', 'oauth2', 'https://www.facebook.com/v18.0/dialog/oauth', ...),
  ('stripe', 'Stripe', 'api_key', NULL, NULL, NULL),
  ('tiktok', 'TikTok Ads', 'oauth2', 'https://business-api.tiktok.com/portal/auth', ...);
```

### Encryption Architecture

**Master Key:** Stored in Cloudflare Secrets Store (`ENCRYPTION_KEY`)
**Algorithm:** AES-256-GCM with random IVs
**Format:** `{iv}:{encrypted_data}:{auth_tag}` (base64-encoded)

```typescript
// From src/utils/crypto.ts (already deployed)
class FieldEncryption {
  async encrypt(plaintext: string): Promise<string>
  async decrypt(ciphertext: string): Promise<string>
}
```

**Cron Worker MUST use the same encryption key** to decrypt tokens from D1.

### OAuth Token Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User initiates OAuth (API Worker)                           │
│    POST /v1/connectors/google/connect                          │
│    → Redirects to Google OAuth consent screen                  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. User grants permissions                                      │
│    Google redirects back with authorization code                │
│    GET /v1/connectors/google/callback?code=...                 │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. API Worker exchanges code for tokens                        │
│    - access_token (expires in 1 hour)                          │
│    - refresh_token (expires in 6 months, reusable)             │
│    Stores ENCRYPTED in platform_connections                    │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Cron Worker checks expiration (every 15 min)                │
│    IF expires_at < now + 5 minutes:                            │
│      - Decrypt refresh_token_encrypted                         │
│      - Call OAuth provider's token refresh endpoint            │
│      - Get new access_token (and sometimes new refresh_token)  │
│      - Encrypt and update credentials_encrypted                │
│      - Update expires_at                                       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Queue Consumer uses fresh token                             │
│    - Decrypt credentials_encrypted                             │
│    - Make API calls to platform                                │
│    - Fetch data, write to Supabase                             │
└─────────────────────────────────────────────────────────────────┘
```

### Existing Services (API Worker)

The API Worker has these services you'll need to understand:

#### `ConnectorService` (`src/services/connectors.ts`)

```typescript
class ConnectorService {
  constructor(private db: D1Database, encryptionKey?: string)

  // Methods you'll use in Cron Worker:
  async getOrganizationConnections(organizationId: string): Promise<PlatformConnection[]>
  async getAccessToken(connectionId: string): Promise<string | null>
  async getRefreshToken(connectionId: string): Promise<string | null>
  async updateAccessToken(connectionId: string, accessToken: string, expiresIn?: number): Promise<void>
  async isTokenExpired(connectionId: string): Promise<boolean>
  async updateSyncStatus(connectionId: string, status: string, error?: string): Promise<void>
}
```

#### `OnboardingService` (`src/services/onboarding.ts`)

```typescript
class OnboardingService {
  constructor(private db: D1Database)

  // Queue Consumer will call this:
  async markFirstSyncCompleted(userId: string): Promise<void>
  // Auto-advances onboarding from 'first_sync' to 'completed'
}
```

#### OAuth Providers (`src/services/oauth/`)

```typescript
// Base class
abstract class OAuthProvider {
  async exchangeCodeForToken(code: string): Promise<OAuthTokens>
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens>
  abstract getUserInfo(accessToken: string): Promise<OAuthUserInfo>
}

// Implementations
class GoogleAdsOAuthProvider extends OAuthProvider { ... }
class FacebookAdsOAuthProvider extends OAuthProvider { ... }
```

**Cron Worker will reuse these OAuth providers** for token refresh.

---

## Part 2: Cron Worker Architecture

### Responsibilities

The Cron Worker is a **lightweight scheduler** that:

1. ✅ Runs on a fixed schedule (every 15 minutes)
2. ✅ Queries D1 for active connections due for sync
3. ✅ Checks token expiration and refreshes if needed
4. ✅ Creates `sync_jobs` records
5. ✅ Enqueues messages to Cloudflare Queue
6. ❌ Does NOT execute actual data syncing (that's Queue Consumer's job)

### Scheduling Logic

**Sync Frequency:** Configurable per connection (default: every 1 hour)

```typescript
// Pseudo-code for connection selection
SELECT * FROM platform_connections
WHERE is_active = 1
  AND (
    last_synced_at IS NULL                              -- Never synced
    OR last_synced_at < datetime('now', '-1 hour')      -- Synced over 1 hour ago
  )
  AND sync_status != 'syncing'                          -- Not currently syncing
ORDER BY last_synced_at ASC NULLS FIRST                 -- Prioritize oldest
LIMIT 100;                                              -- Batch size
```

### Token Refresh Strategy

**Proactive Refresh:** Refresh tokens 5 minutes before expiration

```typescript
// For each connection found:
if (connection.expires_at && new Date(connection.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
  // Token expires in < 5 minutes, refresh it
  const refreshToken = await connectorService.getRefreshToken(connection.id);
  const oauthProvider = getOAuthProvider(connection.platform);
  const newTokens = await oauthProvider.refreshAccessToken(refreshToken);
  await connectorService.updateAccessToken(connection.id, newTokens.access_token, newTokens.expires_in);
}
```

**Providers with different refresh behavior:**
- **Google:** Refresh tokens are long-lived (6 months), always return new access_token
- **Facebook:** Use `/oauth/access_token` endpoint to exchange for 60-day long-lived tokens
- **Stripe:** API keys don't expire (no refresh needed)
- **TikTok:** Similar to Google (refresh_token is long-lived)

### Queue Message Format

Each job gets a message sent to the Cloudflare Queue:

```typescript
interface SyncJobMessage {
  job_id: string;                    // UUID from sync_jobs table
  connection_id: string;             // FK to platform_connections
  organization_id: string;           // For data partitioning
  platform: string;                  // 'google', 'facebook', etc.
  account_id: string;                // Platform account ID
  job_type: 'full' | 'incremental'; // Full sync or incremental
  sync_window: {
    start: string;                   // ISO timestamp
    end: string;                     // ISO timestamp
  };
  metadata: {
    retry_count: number;
    created_at: string;
    priority: 'high' | 'normal';
  };
}
```

### Error Handling

```typescript
try {
  // 1. Query connections
  const connections = await getConnectionsDueForSync();

  for (const conn of connections) {
    try {
      // 2. Refresh token if needed
      await refreshTokenIfExpired(conn);

      // 3. Create sync job
      const jobId = await createSyncJob(conn);

      // 4. Enqueue message
      await env.SYNC_QUEUE.send({
        job_id: jobId,
        connection_id: conn.id,
        // ... rest of message
      });

    } catch (connError) {
      // Log error, update sync_status = 'failed'
      await connectorService.updateSyncStatus(conn.id, 'failed', connError.message);
      // Continue with next connection
    }
  }
} catch (error) {
  // Fatal error, log and alert
  console.error('Cron job failed:', error);
  throw error; // Cloudflare will retry cron
}
```

### Performance Considerations

**Target:** Process 100-500 connections per run (15-minute window)

- **Batch size:** 100 connections per iteration
- **Token refresh:** ~200ms per refresh API call
- **D1 queries:** ~10ms per query
- **Queue sends:** ~5ms per message

**Estimated execution time:**
- 100 connections with 10% token refresh = ~2 seconds total

**Rate limiting:**
- Google OAuth: 10 requests/second
- Facebook OAuth: 200 requests/hour
- **Strategy:** Space out token refreshes (100ms delay between refreshes)

---

## Part 3: Implementation Guide

### Project Setup

Create a new Cloudflare Worker project:

```bash
# Create new worker directory
mkdir clearlift-cron-worker
cd clearlift-cron-worker

# Initialize with Wrangler
npm init -y
npm install --save-dev wrangler typescript
npm install zod  # For message validation

# Initialize TypeScript
npx tsc --init
```

### File Structure

```
clearlift-cron-worker/
├── src/
│   ├── index.ts                  # Main cron handler
│   ├── types.ts                  # TypeScript types
│   ├── services/
│   │   ├── connectors.ts         # Copy from API worker
│   │   ├── syncScheduler.ts      # NEW: Sync scheduling logic
│   │   └── oauth/
│   │       ├── base.ts           # Copy from API worker
│   │       ├── google.ts         # Copy from API worker
│   │       └── facebook.ts       # Copy from API worker
│   └── utils/
│       ├── crypto.ts             # Copy from API worker
│       └── logger.ts             # NEW: Structured logging
├── wrangler.jsonc                # Worker configuration
├── package.json
└── tsconfig.json
```

### Step 1: Copy Shared Code

**Copy these files from API Worker:**

```bash
# From clearlift-api repo:
cp src/utils/crypto.ts ../clearlift-cron-worker/src/utils/
cp src/services/connectors.ts ../clearlift-cron-worker/src/services/
cp -r src/services/oauth ../clearlift-cron-worker/src/services/
```

**Why?** The Cron Worker needs the same encryption utilities and OAuth providers to refresh tokens.

### Step 2: Create Types (`src/types.ts`)

```typescript
// Environment bindings
export interface Env {
  DB: D1Database;                          // D1 database (same as API worker)
  SYNC_QUEUE: Queue<SyncJobMessage>;       // Cloudflare Queue binding
  ENCRYPTION_KEY: string;                  // From Secrets Store

  // OAuth credentials (from Secrets Store)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  FACEBOOK_APP_ID: string;
  FACEBOOK_APP_SECRET: string;
  TIKTOK_APP_KEY: string;
  TIKTOK_APP_SECRET: string;
}

// Queue message schema
export interface SyncJobMessage {
  job_id: string;
  connection_id: string;
  organization_id: string;
  platform: 'google' | 'facebook' | 'tiktok' | 'stripe';
  account_id: string;
  job_type: 'full' | 'incremental';
  sync_window: {
    start: string;  // ISO 8601
    end: string;
  };
  metadata: {
    retry_count: number;
    created_at: string;
    priority: 'high' | 'normal';
  };
}

// Database types
export interface PlatformConnection {
  id: string;
  organization_id: string;
  platform: string;
  account_id: string;
  account_name: string | null;
  connected_by: string;
  connected_at: string;
  last_synced_at: string | null;
  sync_status: 'pending' | 'syncing' | 'completed' | 'failed';
  sync_error: string | null;
  is_active: boolean;
  expires_at: string | null;
  scopes: string[];
}

export interface SyncJob {
  id: string;
  organization_id: string;
  connection_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  job_type: 'full' | 'incremental';
  created_at: string;
  metadata: Record<string, any>;
}
```

### Step 3: Create Sync Scheduler Service (`src/services/syncScheduler.ts`)

```typescript
import { ConnectorService, PlatformConnection } from './connectors';
import { GoogleAdsOAuthProvider } from './oauth/google';
import { FacebookAdsOAuthProvider } from './oauth/facebook';
import { SyncJobMessage, Env } from '../types';

export class SyncSchedulerService {
  private connectorService: ConnectorService;

  constructor(private env: Env) {
    this.connectorService = new ConnectorService(env.DB, env.ENCRYPTION_KEY);
  }

  /**
   * Get connections that need syncing
   */
  async getConnectionsDueForSync(limit: number = 100): Promise<PlatformConnection[]> {
    const result = await this.env.DB.prepare(`
      SELECT
        id, organization_id, platform, account_id, account_name,
        connected_by, connected_at, last_synced_at, sync_status,
        is_active, expires_at, scopes
      FROM platform_connections
      WHERE is_active = 1
        AND sync_status != 'syncing'
        AND (
          last_synced_at IS NULL
          OR last_synced_at < datetime('now', '-1 hour')
        )
      ORDER BY last_synced_at ASC NULLS FIRST
      LIMIT ?
    `).bind(limit).all<PlatformConnection>();

    return (result.results || []).map(conn => ({
      ...conn,
      scopes: conn.scopes ? JSON.parse(conn.scopes as any) : []
    }));
  }

  /**
   * Refresh OAuth token if expired
   */
  async refreshTokenIfNeeded(connection: PlatformConnection): Promise<void> {
    // Skip if no expiration or not expired
    if (!connection.expires_at) {
      return;
    }

    const expiresAt = new Date(connection.expires_at);
    const now = new Date();
    const bufferMinutes = 5;

    // Check if token expires within buffer window
    if (expiresAt > new Date(now.getTime() + bufferMinutes * 60 * 1000)) {
      return; // Token is still valid
    }

    console.log(`Refreshing token for connection ${connection.id}`);

    try {
      // Get refresh token
      const refreshToken = await this.connectorService.getRefreshToken(connection.id);
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      // Get OAuth provider
      const provider = this.getOAuthProvider(connection.platform);

      // Refresh token
      const newTokens = await provider.refreshAccessToken(refreshToken);

      // Update in database
      await this.connectorService.updateAccessToken(
        connection.id,
        newTokens.access_token,
        newTokens.expires_in
      );

      console.log(`Token refreshed successfully for ${connection.id}`);
    } catch (error) {
      console.error(`Failed to refresh token for ${connection.id}:`, error);
      throw error;
    }
  }

  /**
   * Create sync job record in D1
   */
  async createSyncJob(connection: PlatformConnection): Promise<string> {
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Determine sync window
    const syncWindow = this.calculateSyncWindow(connection);

    await this.env.DB.prepare(`
      INSERT INTO sync_jobs (
        id, organization_id, connection_id, status, job_type,
        created_at, metadata
      )
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).bind(
      jobId,
      connection.organization_id,
      connection.id,
      syncWindow.type,
      now,
      JSON.stringify({
        platform: connection.platform,
        account_id: connection.account_id,
        sync_window: syncWindow,
        created_by: 'cron-worker'
      })
    ).run();

    return jobId;
  }

  /**
   * Send job message to queue
   */
  async enqueueJob(jobId: string, connection: PlatformConnection, syncWindow: any): Promise<void> {
    const message: SyncJobMessage = {
      job_id: jobId,
      connection_id: connection.id,
      organization_id: connection.organization_id,
      platform: connection.platform as any,
      account_id: connection.account_id,
      job_type: syncWindow.type,
      sync_window: {
        start: syncWindow.start,
        end: syncWindow.end
      },
      metadata: {
        retry_count: 0,
        created_at: new Date().toISOString(),
        priority: connection.last_synced_at ? 'normal' : 'high' // First sync is high priority
      }
    };

    await this.env.SYNC_QUEUE.send(message);
  }

  /**
   * Calculate sync window based on last sync
   */
  private calculateSyncWindow(connection: PlatformConnection) {
    const now = new Date();
    const lastSynced = connection.last_synced_at ? new Date(connection.last_synced_at) : null;

    if (!lastSynced) {
      // First sync: get last 7 days
      return {
        type: 'full' as const,
        start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        end: now.toISOString()
      };
    } else {
      // Incremental: from last sync to now
      return {
        type: 'incremental' as const,
        start: lastSynced.toISOString(),
        end: now.toISOString()
      };
    }
  }

  /**
   * Get OAuth provider for platform
   */
  private getOAuthProvider(platform: string) {
    switch (platform) {
      case 'google':
        return new GoogleAdsOAuthProvider(
          this.env.GOOGLE_CLIENT_ID,
          this.env.GOOGLE_CLIENT_SECRET,
          'https://api.clearlift.ai/v1/connectors/google/callback' // Not used for refresh
        );
      case 'facebook':
        return new FacebookAdsOAuthProvider(
          this.env.FACEBOOK_APP_ID,
          this.env.FACEBOOK_APP_SECRET,
          'https://api.clearlift.ai/v1/connectors/facebook/callback'
        );
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  /**
   * Update connection sync status
   */
  async updateConnectionStatus(connectionId: string, status: string, error?: string): Promise<void> {
    await this.connectorService.updateSyncStatus(connectionId, status, error);
  }
}
```

### Step 4: Create Main Handler (`src/index.ts`)

```typescript
import { Env, SyncJobMessage } from './types';
import { SyncSchedulerService } from './services/syncScheduler';

/**
 * Cron Worker Entry Point
 * Runs every 15 minutes via scheduled trigger
 */
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('🕐 Cron job started at', new Date().toISOString());

    const scheduler = new SyncSchedulerService(env);
    let processed = 0;
    let failed = 0;

    try {
      // 1. Get connections due for sync
      const connections = await scheduler.getConnectionsDueForSync(100);
      console.log(`📋 Found ${connections.length} connections to sync`);

      if (connections.length === 0) {
        console.log('✅ No connections need syncing');
        return;
      }

      // 2. Process each connection
      for (const connection of connections) {
        try {
          console.log(`🔄 Processing ${connection.platform} connection ${connection.id}`);

          // 3. Refresh token if needed
          await scheduler.refreshTokenIfNeeded(connection);

          // 4. Create sync job
          const jobId = await scheduler.createSyncJob(connection);
          console.log(`📝 Created job ${jobId}`);

          // 5. Calculate sync window
          const syncWindow = {
            type: connection.last_synced_at ? 'incremental' : 'full',
            start: connection.last_synced_at || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            end: new Date().toISOString()
          };

          // 6. Enqueue message
          await scheduler.enqueueJob(jobId, connection, syncWindow);
          console.log(`📤 Enqueued job to sync-jobs queue`);

          processed++;

          // Rate limiting: small delay between connections
          await sleep(100);

        } catch (error) {
          console.error(`❌ Failed to process connection ${connection.id}:`, error);
          await scheduler.updateConnectionStatus(connection.id, 'failed', error instanceof Error ? error.message : 'Unknown error');
          failed++;
        }
      }

      console.log(`✅ Cron job completed: ${processed} processed, ${failed} failed`);

    } catch (error) {
      console.error('💥 Fatal error in cron job:', error);
      throw error; // Cloudflare will retry
    }
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Step 5: Configure Wrangler (`wrangler.jsonc`)

```json
{
  "name": "clearlift-cron-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-04-01",

  "triggers": {
    "crons": ["*/15 * * * *"]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ClearLiftDash-D1",
      "database_id": "89bd84be-b517-4c72-ab61-422384319361"
    }
  ],

  "queues": {
    "producers": [
      {
        "binding": "SYNC_QUEUE",
        "queue": "sync-jobs"
      }
    ]
  },

  "secrets_store_secrets": [
    {
      "binding": "ENCRYPTION_KEY",
      "store_id": "b97bbcc69dce4f59b1043024f8a68f19",
      "secret_name": "ENCRYPTION_KEY"
    },
    {
      "binding": "GOOGLE_CLIENT_ID",
      "store_id": "b97bbcc69dce4f59b1043024f8a68f19",
      "secret_name": "GOOGLE_CLIENT_ID"
    },
    {
      "binding": "GOOGLE_CLIENT_SECRET",
      "store_id": "b97bbcc69dce4f59b1043024f8a68f19",
      "secret_name": "GOOGLE_CLIENT_SECRET"
    },
    {
      "binding": "FACEBOOK_APP_ID",
      "store_id": "b97bbcc69dce4f59b1043024f8a68f19",
      "secret_name": "FACEBOOK_APP_ID"
    },
    {
      "binding": "FACEBOOK_APP_SECRET",
      "store_id": "b97bbcc69dce4f59b1043024f8a68f19",
      "secret_name": "FACEBOOK_APP_SECRET"
    }
  ],

  "observability": {
    "enabled": true
  }
}
```

**Cron Schedule Explained:**
- `"*/15 * * * *"` = Every 15 minutes
- Alternative: `"0,15,30,45 * * * *"` = At :00, :15, :30, :45 past every hour

---

## Part 4: Deployment

### Prerequisites

1. **Cloudflare account with Workers Paid plan**
   - Cron Triggers require paid plan ($5/month)
   - Queues require paid plan

2. **Wrangler CLI authenticated**
   ```bash
   npx wrangler login
   ```

3. **Same D1 database as API Worker**
   - Database ID: `89bd84be-b517-4c72-ab61-422384319361`

### Step 1: Create Cloudflare Queue

```bash
# Create the queue
npx wrangler queues create sync-jobs

# Output:
# ✅ Created queue sync-jobs
```

**Queue Configuration:**
- **Name:** `sync-jobs`
- **Max Retries:** 3 (default)
- **Delivery Delay:** 0 seconds
- **Message Retention:** 4 days

### Step 2: Add OAuth Credentials to Secrets Store

You need to obtain OAuth credentials from each platform:

#### Google Ads OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project or select existing
3. Enable "Google Ads API"
4. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
5. Application type: **Web application**
6. Authorized redirect URIs: `https://api.clearlift.ai/v1/connectors/google/callback`
7. Copy **Client ID** and **Client Secret**

```bash
# Add to Cloudflare Secrets Store
npx wrangler secret put GOOGLE_CLIENT_ID --name clearlift-cron-worker
# Paste your Google Client ID

npx wrangler secret put GOOGLE_CLIENT_SECRET --name clearlift-cron-worker
# Paste your Google Client Secret
```

#### Facebook Ads OAuth Setup

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Create app or use existing
3. Add "Facebook Login" product
4. Settings → Basic: Copy **App ID** and **App Secret**
5. Facebook Login → Settings:
   - Valid OAuth Redirect URIs: `https://api.clearlift.ai/v1/connectors/facebook/callback`

```bash
npx wrangler secret put FACEBOOK_APP_ID --name clearlift-cron-worker
# Paste Facebook App ID

npx wrangler secret put FACEBOOK_APP_SECRET --name clearlift-cron-worker
# Paste Facebook App Secret
```

#### Encryption Key (Same as API Worker)

```bash
# Use the SAME key as API Worker
npx wrangler secret put ENCRYPTION_KEY --name clearlift-cron-worker
# Paste: hI9ZjRD1XYpWgeLiiHpHp2aaHv8EjzkYZSqzwK3kVUA=
```

⚠️ **IMPORTANT:** The encryption key MUST be identical to the API Worker, or you won't be able to decrypt tokens.

### Step 3: Test Locally (Optional)

```bash
# Run dev server
npx wrangler dev

# Manually trigger cron (in another terminal)
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

**Expected output:**
```
🕐 Cron job started at 2025-10-10T12:00:00.000Z
📋 Found 3 connections to sync
🔄 Processing google connection org-123-google-456
📝 Created job f8e3c2a1-...
📤 Enqueued job to sync-jobs queue
✅ Cron job completed: 3 processed, 0 failed
```

### Step 4: Deploy to Production

```bash
# Build and deploy
npx wrangler deploy

# Output:
# ✨ Built successfully, built project size is 156 KiB.
# ✨ Uploaded clearlift-cron-worker
# ✨ Deployed clearlift-cron-worker triggers (beta)
#   • 0,15,30,45 * * * *
# ✅ Deployment complete! Took 2.34s
```

### Step 5: Verify Cron Schedule

```bash
# List all cron triggers
npx wrangler triggers list

# Check logs for next execution
npx wrangler tail --format pretty
```

**Wait up to 15 minutes for first execution**, then check logs.

### Step 6: Monitor First Execution

```bash
# Tail logs in real-time
npx wrangler tail --name clearlift-cron-worker --format pretty
```

**Look for:**
- `🕐 Cron job started at ...`
- `📋 Found X connections to sync`
- `📤 Enqueued job to sync-jobs queue`
- `✅ Cron job completed`

---

## Part 5: Testing

### Test Scenario 1: Fresh Connection (No Prior Sync)

**Setup:**
1. Use API Worker to connect a Google Ads account
2. Wait for next cron execution (up to 15 minutes)

**Expected Behavior:**
```
Connection in D1:
  last_synced_at: NULL
  sync_status: 'pending'

Cron Worker Actions:
  ✅ Finds connection (last_synced_at IS NULL)
  ✅ Creates job with job_type='full', 7-day window
  ✅ Enqueues message with priority='high'
  ✅ Leaves last_synced_at NULL (Queue Consumer will update)
```

**Verification:**
```sql
-- Check sync_jobs table
SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT 5;
-- Should see new job with status='pending'

-- Check queue (Cloudflare dashboard)
-- Queue "sync-jobs" should have 1 message
```

### Test Scenario 2: Token Refresh

**Setup:**
1. Manually update a connection's `expires_at` to 2 minutes from now
2. Wait for next cron execution

```sql
UPDATE platform_connections
SET expires_at = datetime('now', '+2 minutes')
WHERE id = 'test-connection-id';
```

**Expected Behavior:**
```
Cron Worker Actions:
  ✅ Detects token expires in < 5 minutes
  ✅ Decrypts refresh_token_encrypted
  ✅ Calls OAuth provider's token endpoint
  ✅ Encrypts new access_token
  ✅ Updates credentials_encrypted and expires_at
  ✅ Proceeds to create sync job
```

**Verification:**
```sql
SELECT expires_at, sync_status FROM platform_connections WHERE id = 'test-connection-id';
-- expires_at should be ~1 hour in the future
```

### Test Scenario 3: Rate Limiting

**Setup:**
1. Create 10 connections via API Worker
2. Disable Queue Consumer (so jobs don't complete)
3. Wait for cron execution

**Expected Behavior:**
```
Cron Worker:
  ✅ Processes all 10 connections
  ✅ Adds 100ms delay between each
  ✅ Completes in ~2 seconds
  ✅ Enqueues 10 messages

Queue:
  ✅ Contains 10 messages
  ✅ Messages retained until consumer processes them
```

### Test Scenario 4: Error Handling (Invalid Refresh Token)

**Setup:**
1. Manually corrupt a refresh_token_encrypted value
2. Update expires_at to force refresh

```sql
UPDATE platform_connections
SET refresh_token_encrypted = 'corrupted:data:here',
    expires_at = datetime('now', '+2 minutes')
WHERE id = 'test-connection-id';
```

**Expected Behavior:**
```
Cron Worker:
  ❌ Token refresh fails
  ✅ Catches error
  ✅ Updates sync_status='failed'
  ✅ Sets sync_error='Token refresh failed: ...'
  ✅ Continues processing other connections
```

**Verification:**
```sql
SELECT sync_status, sync_error FROM platform_connections WHERE id = 'test-connection-id';
-- sync_status: 'failed'
-- sync_error: 'Token refresh failed: invalid refresh token'
```

---

## Part 6: Monitoring

### Cloudflare Dashboard

**Workers & Pages → clearlift-cron-worker:**

1. **Metrics:**
   - Invocations (should match cron schedule)
   - Errors (should be 0)
   - CPU Time (should be < 1 second per invocation)

2. **Logs (Real-time):**
   - Click "Begin log stream"
   - Wait for next cron execution
   - Watch for error messages

3. **Cron Triggers:**
   - Verify schedule shows `*/15 * * * *`
   - Check "Last Run" timestamp
   - Review "Past Events" for failures

### Queue Monitoring

**Workers & Pages → Queues → sync-jobs:**

1. **Queue Depth:**
   - Should gradually fill if Queue Consumer is not yet deployed
   - Should stay near 0 once consumer is running

2. **Message Rate:**
   - Expect bursts every 15 minutes
   - Rate = (number of active connections) messages per 15 min

3. **Dead Letter Queue:**
   - Monitor for messages that failed processing
   - Indicates issues with consumer or message format

### D1 Database Queries

```sql
-- Check recent sync jobs
SELECT
  sj.id,
  sj.connection_id,
  pc.platform,
  pc.account_name,
  sj.status,
  sj.created_at
FROM sync_jobs sj
JOIN platform_connections pc ON sj.connection_id = pc.id
ORDER BY sj.created_at DESC
LIMIT 20;

-- Count jobs by status
SELECT status, COUNT(*) as count
FROM sync_jobs
WHERE created_at > datetime('now', '-1 day')
GROUP BY status;

-- Find connections with repeated failures
SELECT
  connection_id,
  COUNT(*) as failure_count,
  MAX(created_at) as last_failure
FROM sync_jobs
WHERE status = 'failed'
  AND created_at > datetime('now', '-1 day')
GROUP BY connection_id
HAVING COUNT(*) > 3;
```

### Alert Setup (Recommended)

Use Cloudflare's built-in alerting:

1. **Workers & Pages → clearlift-cron-worker → Alerts:**
   - **Error Rate Threshold:** > 10% of invocations fail
   - **Notification:** Email + Slack

2. **Queues → sync-jobs → Alerts:**
   - **Queue Depth:** > 500 messages (backlog building up)
   - **Message Age:** > 1 hour (messages not being processed)

---

## Next Steps: Queue Consumer Worker

Once the Cron Worker is deployed and tested, you'll implement the **Queue Consumer Worker** that:

1. ✅ Consumes messages from `sync-jobs` queue
2. ✅ Decrypts access tokens
3. ✅ Calls platform APIs (Google Ads, Facebook Ads, etc.)
4. ✅ Transforms data to common schema
5. ✅ Writes to Supabase PostgreSQL
6. ✅ Updates `sync_jobs.status` to `'completed'`
7. ✅ Updates `platform_connections.last_synced_at`
8. ✅ Calls `OnboardingService.markFirstSyncCompleted()` for first syncs

**Queue Consumer Guide will cover:**
- Platform API SDKs and authentication
- Data transformation pipelines
- Supabase write operations
- Idempotency and deduplication
- Retry strategies and dead letter queue handling

---

## Appendix

### A. Cron Schedule Examples

```bash
# Every 15 minutes
"*/15 * * * *"

# Every hour at minute 0
"0 * * * *"

# Every 30 minutes
"*/30 * * * *"

# Every 6 hours
"0 */6 * * *"

# Daily at 3 AM UTC
"0 3 * * *"

# Weekdays at 9 AM UTC
"0 9 * * 1-5"
```

### B. Troubleshooting

#### Problem: Cron doesn't run

**Symptoms:** No logs in dashboard, no jobs created

**Causes:**
1. Worker not deployed (`npx wrangler deploy`)
2. Cron trigger not configured in wrangler.jsonc
3. Cloudflare Workers Paid plan not active

**Fix:**
```bash
npx wrangler triggers list
# Should show cron schedule
```

#### Problem: "DB is undefined"

**Symptoms:** `Cannot read property 'prepare' of undefined`

**Causes:**
1. D1 binding not configured in wrangler.jsonc
2. Wrong database ID

**Fix:**
```json
// wrangler.jsonc
"d1_databases": [{
  "binding": "DB",  // Must match Env interface
  "database_id": "89bd84be-b517-4c72-ab61-422384319361"
}]
```

#### Problem: "SYNC_QUEUE is undefined"

**Symptoms:** `Cannot read property 'send' of undefined`

**Causes:**
1. Queue not created (`npx wrangler queues create sync-jobs`)
2. Queue binding not configured

**Fix:**
```json
// wrangler.jsonc
"queues": {
  "producers": [{
    "binding": "SYNC_QUEUE",  // Must match Env interface
    "queue": "sync-jobs"
  }]
}
```

#### Problem: Token refresh fails

**Symptoms:** All refreshes fail with 401 Unauthorized

**Causes:**
1. Wrong OAuth client credentials
2. Refresh token expired (> 6 months old)
3. User revoked access

**Fix:**
- Verify secrets are correct: `npx wrangler secret list`
- Check platform's OAuth dashboard for app status
- User must reconnect via API Worker

#### Problem: Queue fills up, jobs not processed

**Symptoms:** Queue depth keeps growing

**Causes:**
1. Queue Consumer not deployed yet (**expected at this stage**)
2. Consumer has errors
3. Consumer rate-limited by platforms

**Fix:**
- Monitor queue in dashboard
- Once consumer is deployed, queue should drain
- If persistent, check consumer logs

### C. Useful Commands

```bash
# Deploy
npx wrangler deploy

# Tail logs
npx wrangler tail --name clearlift-cron-worker --format pretty

# List cron triggers
npx wrangler triggers list

# Manually trigger cron (local dev only)
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"

# List secrets
npx wrangler secret list --name clearlift-cron-worker

# View queue stats
npx wrangler queues list

# Check D1 data
npx wrangler d1 execute DB --command "SELECT COUNT(*) FROM sync_jobs WHERE created_at > datetime('now', '-1 hour')"

# View worker metrics
npx wrangler metrics --name clearlift-cron-worker

# Roll back deployment
npx wrangler rollback --name clearlift-cron-worker
```

---

## Summary

You now have a complete guide to deploy the **Cron Worker** for ClearLift's multi-connector data sync platform.

**Key Points:**

1. ✅ **API Worker (deployed)** handles OAuth, stores encrypted credentials
2. ⏳ **Cron Worker (this guide)** schedules syncs, refreshes tokens, enqueues jobs
3. 🔜 **Queue Consumer (future)** executes syncs, writes to Supabase

**What the Cron Worker does:**
- Runs every 15 minutes automatically
- Finds connections due for sync (based on `last_synced_at`)
- Refreshes OAuth tokens proactively (5-minute buffer)
- Creates `sync_jobs` records in D1
- Enqueues messages to Cloudflare Queue

**What it does NOT do:**
- Does not call platform APIs (Google Ads, Facebook Ads, etc.)
- Does not fetch actual data
- Does not write to Supabase
- That's the Queue Consumer's job!

**Deployment Checklist:**

- [ ] Create new worker project directory
- [ ] Copy shared code (crypto.ts, connectors.ts, oauth/)
- [ ] Implement SyncSchedulerService
- [ ] Configure wrangler.jsonc with cron schedule
- [ ] Create Cloudflare Queue (`sync-jobs`)
- [ ] Add OAuth credentials to Secrets Store
- [ ] Deploy with `npx wrangler deploy`
- [ ] Monitor first cron execution
- [ ] Verify jobs created in D1
- [ ] Verify messages in queue

**Once deployed, you're ready to build the Queue Consumer Worker!**

---

**Questions? Issues?**

Check the troubleshooting section or review the API Worker code at `api.clearlift.ai` for reference implementations of encryption and OAuth handling.

**Good luck! 🚀**
