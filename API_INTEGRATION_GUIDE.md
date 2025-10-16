# API Integration Guide - ClearLift Background Workers

**For:** API Developer
**Purpose:** How to integrate with the new Cron + Queue Consumer workers
**Date:** 2025-10-10

---

## 🎯 Overview

The ClearLift backend now has **automated data syncing** via two background workers. Your API worker handles OAuth, and our workers handle everything else automatically.

### What Changed

**Before:**
- API Worker handled OAuth ✅
- API Worker had to manually trigger syncs ❌
- No automatic scheduling ❌

**Now:**
- API Worker handles OAuth ✅
- Background workers automatically sync data ✅
- Scheduled every 15 minutes ✅

---

## 📋 What You Need to Do

### ✅ Already Working (No Changes Needed)

Your API worker is **already integrated** if you're doing these things:

1. **Storing credentials in D1 after OAuth**
   ```sql
   INSERT INTO platform_connections (
     id,
     organization_id,
     platform,
     account_id,
     credentials_encrypted,
     refresh_token_encrypted,
     expires_at,
     is_active
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 1);
   ```

2. **Encrypting tokens with the same ENCRYPTION_KEY**
   - The background workers use the same key to decrypt

3. **Setting `is_active = 1` for active connections**
   - Background workers only sync connections where `is_active = 1`

If you're doing these three things, **you're done**! The workers will automatically pick up new connections.

---

## 🔄 How It Works Now

### The Automated Flow

```
┌─────────────────────────────────────────────────────┐
│  1. User Connects Platform (Your API Worker)       │
│                                                      │
│  POST /v1/connectors/google/connect                │
│  → User completes OAuth                             │
│  → API exchanges code for tokens                    │
│  → Encrypts and stores in D1                        │
│  → Sets is_active = 1                               │
│  → Returns success to user                          │
└────────────────────┬────────────────────────────────┘
                     │
                     │ Token stored in D1
                     ▼
┌─────────────────────────────────────────────────────┐
│  2. Cron Worker (Runs Every 15 Minutes)            │
│     ⚡ Automatic - No API changes needed            │
│                                                      │
│  → Queries: SELECT * FROM platform_connections      │
│             WHERE is_active = 1                     │
│             AND last_synced_at IS NULL              │
│                                                      │
│  → Finds new connection                             │
│  → Creates sync_jobs record                         │
│  → Enqueues message to queue                        │
└────────────────────┬────────────────────────────────┘
                     │
                     │ Job enqueued
                     ▼
┌─────────────────────────────────────────────────────┐
│  3. Queue Consumer (Triggered by Queue)            │
│     ⚡ Automatic - No API changes needed            │
│                                                      │
│  → Receives message from queue                      │
│  → Decrypts access_token from D1                    │
│  → Calls Google Ads / Facebook API                  │
│  → Fetches campaigns + metrics (last 7 days)        │
│  → Writes to Supabase PostgreSQL                    │
│  → Updates sync_jobs.status = 'completed'           │
│  → Updates platform_connections.last_synced_at      │
└─────────────────────────────────────────────────────┘
```

**Time from connection to first sync:** Maximum 15 minutes (next cron run)

---

## 📊 Database Tables You Interact With

### 1. `platform_connections` (You write, workers read)

**What you store:**
```typescript
interface PlatformConnection {
  id: string;                        // {org_id}-{platform}-{account_id}
  organization_id: string;
  platform: string;                  // 'google', 'facebook', 'tiktok', 'stripe'
  account_id: string;                // Platform's account ID
  account_name: string;
  connected_by: string;              // User ID

  // Encrypted credentials (use FieldEncryption)
  credentials_encrypted: string;     // Encrypted access_token
  refresh_token_encrypted: string;   // Encrypted refresh_token
  expires_at: string;                // ISO timestamp

  is_active: boolean;                // ⚠️ IMPORTANT: Set to 1
  last_synced_at: string | null;    // Workers update this
  sync_status: string;               // Workers update this
}
```

**Critical fields for workers:**
- ✅ `is_active = 1` - Workers only sync active connections
- ✅ `credentials_encrypted` - Must be encrypted with ENCRYPTION_KEY
- ✅ `refresh_token_encrypted` - Needed for token refresh
- ✅ `expires_at` - Workers check this to refresh tokens

### 2. `sync_jobs` (Workers write, you can read)

**Created by cron worker, updated by queue consumer:**
```typescript
interface SyncJob {
  id: string;
  organization_id: string;
  connection_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  job_type: 'full' | 'incremental';
  started_at: string | null;
  completed_at: string | null;
  records_synced: number;
  error_message: string | null;
}
```

**You can query this to show users sync status:**
```sql
-- Get latest sync for a connection
SELECT status, completed_at, records_synced, error_message
FROM sync_jobs
WHERE connection_id = ?
ORDER BY created_at DESC
LIMIT 1;
```

---

## 🔧 API Endpoints - What to Change

### Option A: No Changes (Simplest)

**If you're already storing connections correctly, you're done.**

Workers will automatically:
- Pick up new connections within 15 minutes
- Sync data every hour after that
- Refresh tokens before they expire

### Option B: Add Sync Status Endpoint (Recommended)

Give users visibility into sync status:

```typescript
// GET /v1/connectors/:connection_id/sync-status
export async function getSyncStatus(connectionId: string, db: D1Database) {
  // Get connection info
  const connection = await db.prepare(`
    SELECT
      platform,
      account_name,
      last_synced_at,
      sync_status,
      is_active
    FROM platform_connections
    WHERE id = ?
  `).bind(connectionId).first();

  // Get latest sync job
  const latestJob = await db.prepare(`
    SELECT
      status,
      job_type,
      started_at,
      completed_at,
      records_synced,
      error_message
    FROM sync_jobs
    WHERE connection_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(connectionId).first();

  return {
    connection: {
      platform: connection.platform,
      account_name: connection.account_name,
      is_active: connection.is_active,
      last_synced_at: connection.last_synced_at,
      sync_status: connection.sync_status
    },
    latest_sync: latestJob ? {
      status: latestJob.status,
      type: latestJob.job_type,
      completed_at: latestJob.completed_at,
      records_synced: latestJob.records_synced,
      error: latestJob.error_message
    } : null
  };
}
```

**Response example:**
```json
{
  "connection": {
    "platform": "google",
    "account_name": "My Ads Account",
    "is_active": true,
    "last_synced_at": "2025-10-10T20:45:30Z",
    "sync_status": "completed"
  },
  "latest_sync": {
    "status": "completed",
    "type": "full",
    "completed_at": "2025-10-10T20:45:30Z",
    "records_synced": 45,
    "error": null
  }
}
```

### Option C: Add Manual Sync Trigger (Optional)

If you want users to manually trigger a sync:

```typescript
// POST /v1/connectors/:connection_id/sync
export async function triggerSync(
  connectionId: string,
  db: D1Database,
  queue: Queue
) {
  // Get connection
  const connection = await db.prepare(`
    SELECT * FROM platform_connections WHERE id = ? AND is_active = 1
  `).bind(connectionId).first();

  if (!connection) {
    return { error: 'Connection not found or inactive' };
  }

  // Create sync job
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO sync_jobs (
      id, organization_id, connection_id, status, job_type, created_at
    ) VALUES (?, ?, ?, 'pending', 'full', ?)
  `).bind(jobId, connection.organization_id, connectionId, now).run();

  // Enqueue message (same format as cron worker)
  await queue.send({
    job_id: jobId,
    connection_id: connectionId,
    organization_id: connection.organization_id,
    platform: connection.platform,
    account_id: connection.account_id,
    job_type: 'full',
    sync_window: {
      start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      end: now
    },
    metadata: {
      retry_count: 0,
      created_at: now,
      priority: 'high'
    }
  });

  return {
    success: true,
    job_id: jobId,
    message: 'Sync triggered successfully'
  };
}
```

---

## 🔐 Security - Shared ENCRYPTION_KEY

Both API worker and background workers use the **same ENCRYPTION_KEY** to encrypt/decrypt tokens.

**Important:**
- API Worker encrypts tokens → stores in D1
- Background workers decrypt tokens → use for API calls
- **MUST use the same key** or decryption fails

**Verify your API worker uses:**
```typescript
import { FieldEncryption } from './utils/crypto';

const encryption = await FieldEncryption.create(env.ENCRYPTION_KEY);
const encrypted = await encryption.encrypt(accessToken);
```

**The background workers use the exact same code.**

---

## 📊 Where Synced Data Lives

### Supabase PostgreSQL (Read-Only for API)

Data synced by queue consumer is stored in Supabase:

**Tables:**
- `google_ads_campaigns` - Campaign details
- `google_ads_daily_metrics` - Daily performance metrics
- `facebook_ads_campaigns` - Campaign details
- `facebook_ads_daily_metrics` - Daily insights

**Supabase Connection:**
```typescript
// In your API worker (if you need to read synced data)
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY  // Use anon key for API worker
);

// Query synced data
const { data, error } = await supabase
  .from('google_ads_campaigns')
  .select('*')
  .eq('organization_id', organizationId)
  .order('last_synced_at', { ascending: false });
```

**Note:** Background workers use `SUPABASE_SERVICE_ROLE_KEY` to write. Your API uses `SUPABASE_ANON_KEY` to read (with RLS enforced).

---

## 🧪 Testing the Integration

### 1. Connect a Platform (Your API)

```bash
# Via your API
POST https://api.clearlift.ai/v1/connectors/google/connect
# User completes OAuth
# Check D1: platform_connections table
```

**Verify in D1:**
```sql
SELECT
  id,
  platform,
  is_active,
  last_synced_at
FROM platform_connections
ORDER BY connected_at DESC
LIMIT 1;
```

**Expected:**
- `is_active = 1` ✅
- `last_synced_at = NULL` ✅ (not synced yet)

### 2. Wait for Cron (Max 15 minutes)

```bash
# Monitor cron worker logs
cd clearlift-workers  # The background workers repo
npm run tail:cron
```

**Expected output:**
```
🕐 Cron job started at 2025-10-10T20:45:00Z
📋 Found 1 connections to sync
🔄 Processing google connection org-123-google-456
📝 Created job f8e3c2a1-...
📤 Enqueued job to sync-jobs queue
✅ Cron job completed: 1 processed, 0 failed
```

### 3. Watch Queue Consumer Process

```bash
npm run tail:queue
```

**Expected output:**
```
📥 Processing batch of 1 sync jobs
🔄 Processing job xxx for google (org-123-google-456)
🔵 Syncing Google Ads for account 123456
📊 Fetched 5 campaigns from Google Ads
✅ Job xxx completed: 45 records synced
```

### 4. Verify Data in Supabase

```sql
-- Check campaigns were created
SELECT * FROM google_ads_campaigns
WHERE organization_id = 'your-org-id'
ORDER BY last_synced_at DESC;

-- Check metrics
SELECT * FROM google_ads_daily_metrics
WHERE organization_id = 'your-org-id'
ORDER BY metric_date DESC
LIMIT 20;
```

### 5. Check Sync Status in D1

```sql
-- Connection should be updated
SELECT last_synced_at, sync_status
FROM platform_connections
WHERE id = 'your-connection-id';
-- last_synced_at should have timestamp
-- sync_status should be 'completed'

-- Job should be completed
SELECT status, records_synced
FROM sync_jobs
WHERE connection_id = 'your-connection-id'
ORDER BY created_at DESC
LIMIT 1;
-- status should be 'completed'
-- records_synced should be > 0
```

---

## 🔔 Onboarding Integration (Optional)

If you track onboarding progress:

### Current Onboarding Flow

```typescript
// After user connects first platform
await db.prepare(`
  UPDATE onboarding_progress
  SET services_connected = services_connected + 1,
      current_step = 'first_sync',
      updated_at = datetime('now')
  WHERE user_id = ?
`).bind(userId).run();
```

### Onboarding Completes After First Sync

The queue consumer will automatically update onboarding when first sync completes:

```typescript
// In queue consumer (already implemented)
// After successful first sync:
await db.prepare(`
  UPDATE onboarding_progress
  SET first_sync_completed = TRUE,
      current_step = 'completed',
      completed_at = datetime('now')
  WHERE user_id = ?
    AND first_sync_completed = FALSE
`).bind(userId).run();
```

**Your API can check:**
```sql
SELECT current_step, first_sync_completed
FROM onboarding_progress
WHERE user_id = ?;
```

**Onboarding states:**
- `welcome` → User just signed up
- `connect_services` → Connecting platforms
- `first_sync` → Waiting for first sync (automatic)
- `completed` → First sync done ✅

---

## ⚠️ Important Notes

### 1. Token Refresh is Automatic

**Don't implement token refresh in API worker.**

The cron worker handles this:
- Checks `expires_at` every 15 minutes
- Refreshes tokens 5 minutes before expiration
- Updates `credentials_encrypted` with new token

### 2. Don't Manually Call Platform APIs

**Let the queue consumer handle data fetching.**

Your API worker should:
- ✅ Handle OAuth flows
- ✅ Store encrypted credentials
- ❌ Don't call Google Ads / Facebook API directly

### 3. is_active Flag Controls Syncing

**To pause syncing for a connection:**
```sql
UPDATE platform_connections
SET is_active = 0
WHERE id = ?;
```

**To resume:**
```sql
UPDATE platform_connections
SET is_active = 1
WHERE id = ?;
```

### 4. Sync Frequency

- **First sync:** Within 15 minutes of connection
- **Subsequent syncs:** Every 1 hour (configurable)
- **Token refresh:** Automatic, 5 minutes before expiration

---

## 📞 Support & Questions

### Background Workers Repo
- **Repo:** `clearlift-workers` (cron + queue consumer)
- **Docs:** See `docs/` directory in that repo

### Common Issues

**"No access token found"**
- Verify `credentials_encrypted` is set in D1
- Check ENCRYPTION_KEY is the same in both workers
- Ensure connection has `is_active = 1`

**"Sync not triggering"**
- Check `is_active = 1`
- Verify `last_synced_at` is NULL or > 1 hour old
- Check cron worker logs for errors

**"Data not in Supabase"**
- Check queue consumer logs for errors
- Verify `sync_jobs.status = 'completed'`
- Check Supabase RLS policies allow service role

---

## ✅ Summary - What You Need to Do

### Minimal Integration (Already Done)
- ✅ Store connections in D1 with `is_active = 1`
- ✅ Encrypt tokens with shared ENCRYPTION_KEY
- ✅ Set `expires_at` for OAuth tokens

**That's it! Workers handle the rest.**

### Recommended Additions
- ⚡ Add `/sync-status` endpoint for user visibility
- ⚡ Show sync progress in your UI
- ⚡ Optional: Add manual sync trigger

### Not Required
- ❌ Don't implement token refresh
- ❌ Don't call platform APIs directly
- ❌ Don't schedule syncs manually

---

**The background workers are live and automatically syncing data!** 🚀

If you have questions, check the background workers repo docs or reach out.
