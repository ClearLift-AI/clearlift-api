# ClearLift Complete Architecture & Data Flow

## System Overview

ClearLift is a **multi-worker, multi-database** analytics platform with complete data separation and SOC 2 compliance.

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER INTERACTIONS                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Frontend Apps  →  API Worker  →  Auth + Config  →  Data Access │
│                     ↓                                             │
│                 api.clearlift.ai                                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                     WORKER ECOSYSTEM                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  API Worker          Cron Worker         Queue Consumer          │
│  (This repo)         (Every 15min)       (Process jobs)          │
│                           ↓                    ↓                 │
│                      Creates Jobs         Fetch from APIs        │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DATA STORAGE LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  D1 Database         Supabase            R2 SQL Data Lake       │
│  (Config/Auth)       (Ad Data)           (Analytics)            │
│  AES-256 Encrypted   PostgreSQL          Clickstream Events     │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Component Breakdown

### 1. Workers (3 Separate Deployments)

#### API Worker (api.clearlift.ai)
**Repository:** `/Users/work/Documents/Code/clearlift-api`
**Purpose:** Authentication, API gateway, data access coordination

**Responsibilities:**
- User authentication (session management)
- OAuth flow handling (Google, Facebook, TikTok, Stripe)
- Organization access control (RBAC)
- Data query routing to appropriate database
- Audit logging (SOC 2 compliance)
- Rate limiting and security headers
- Worker health monitoring

**Key Endpoints:**
```
Authentication:
  GET  /v1/user/me
  GET  /v1/user/organizations

OAuth Management:
  POST /v1/connectors/:provider/connect
  GET  /v1/connectors/:provider/callback
  DELETE /v1/connectors/:connection_id

Data Access:
  GET  /v1/analytics/events         → R2 SQL
  GET  /v1/analytics/platforms/:id  → Supabase
  GET  /v1/analytics/unified        → Supabase (multi-platform)

Worker Control:
  GET  /v1/workers/health
  POST /v1/workers/sync/trigger
  GET  /v1/workers/dlq
```

#### Cron Worker (Scheduler)
**URL:** https://clearlift-cron-worker.paul-33c.workers.dev
**Schedule:** Every 15 minutes (`*/15 * * * *`)

**Responsibilities:**
- Query D1 for active platform_connections
- Create sync jobs in Cloudflare Queue
- Track job creation in sync_jobs table
- Handle scheduling logic

#### Queue Consumer (Data Processor)
**URL:** https://clearlift-queue-consumer.paul-33c.workers.dev

**Responsibilities:**
- Consume jobs from sync-jobs queue
- Decrypt OAuth tokens from D1
- Fetch data from advertising APIs
- Transform and normalize data
- Write to Supabase tables
- Update sync status in D1
- Handle retries and failures

### 2. Databases & Storage

#### Cloudflare D1 (SQLite)
**Database ID:** `89bd84be-b517-4c72-ab61-422384319361`
**Purpose:** Configuration, authentication, and orchestration

**Tables & Encryption:**
```sql
users
  - email_encrypted (AES-256-GCM with ENCRYPTION_KEY)
  - email_hash (for lookups without decryption)

sessions
  - token (primary key)
  - ip_address_encrypted (AES-256-GCM)
  - expires_at

organizations
  - id, name, slug
  - subscription_tier

organization_members
  - user_id, organization_id
  - role (viewer/admin/owner)

platform_connections ← CRITICAL
  - credentials_encrypted (OAuth access token)
  - refresh_token_encrypted (OAuth refresh token)
  - Both encrypted with ENCRYPTION_KEY

sync_jobs
  - connection_id, status
  - created by cron, updated by queue

org_tag_mappings ← IMPORTANT
  - Maps organization_id → short_tag
  - Used for R2 SQL partitioning

audit_logs (NEW - SOC 2)
  - Every API request logged
  - User, action, resource, result

auth_audit_logs (NEW - SOC 2)
  - Login/logout events
  - Failed authentication attempts

data_access_logs (NEW - SOC 2)
  - Track data queries
  - PII access flagging

config_audit_logs (NEW - SOC 2)
  - Configuration changes
  - Old/new values

security_events (NEW - SOC 2)
  - SQL injection attempts
  - Rate limit violations
```

#### Supabase PostgreSQL
**Purpose:** Advertising platform data storage
**Access:** Via `SUPABASE_SECRET_KEY` (backend operations)

**Tables (Per Platform):**
```sql
google_ads_campaigns
google_ads_ad_groups
google_ads_ads

facebook_ads_campaigns
facebook_ads_ad_sets
facebook_ads_creatives

tiktok_ads_campaigns
tiktok_ads_creatives

stripe_conversions

All tables include:
  - organization_id (for RLS)
  - spend_cents (standardized currency)
  - api_version (tracking)
  - SOC 2 fields (created_at, updated_at, etc.)
```

**Row-Level Security:**
- Backend workers use service key (bypass RLS)
- Frontend uses publishable key (RLS enforced)
- Each org only sees their data

#### R2 SQL Data Lake
**Purpose:** Clickstream and behavioral analytics
**Access:** Via `R2_SQL_TOKEN`

**Schema:**
```sql
clearlift.event_stream
  - org_tag (partition key - NOT org_id)
  - timestamp, session_id
  - anonymous_id (NO email/PII)
  - event_type, event_data
  - page_url, utm_parameters
  - 60+ additional fields
```

**Key Point:** Uses `org_tag` from org_tag_mappings, not org_id directly

### 3. Data Flow Examples

#### OAuth Connection Flow
```
1. User initiates OAuth in frontend
2. API Worker → POST /v1/connectors/google/connect
3. API Worker creates OAuth state in D1
4. User redirected to Google OAuth
5. Google redirects to /v1/connectors/google/callback
6. API Worker:
   - Validates OAuth state
   - Exchanges code for tokens
   - Encrypts tokens with ENCRYPTION_KEY
   - Stores in platform_connections table
7. Cron Worker (within 15 min):
   - Finds new connection
   - Creates sync job in queue
8. Queue Consumer:
   - Decrypts tokens
   - Fetches Google Ads data
   - Writes to Supabase
```

#### Analytics Query Flow
```
1. User requests analytics
2. API Worker → GET /v1/analytics/events?org_id=123
3. API Worker:
   - Validates user has access to org 123 (D1)
   - Looks up org_tag in org_tag_mappings (D1)
   - Gets tag "abc456"
4. API Worker queries R2 SQL:
   - SELECT * FROM event_stream WHERE org_tag = 'abc456'
5. Returns filtered results to user
```

#### Platform Data Query Flow
```
1. User requests campaign data
2. API Worker → GET /v1/analytics/platforms/google?org_id=123
3. API Worker:
   - Validates org access (D1)
   - Queries Supabase with org_id filter
4. Supabase:
   - RLS would apply if using publishable key
   - Service key bypasses RLS but API filters by org
5. Returns campaign data to user
```

### 4. Security & Encryption

#### Encryption Keys Hierarchy
```
CLOUDFLARE SECRETS STORE
├── ENCRYPTION_KEY (Master key for D1 field encryption)
│   └── Encrypts:
│       ├── platform_connections.credentials_encrypted
│       ├── platform_connections.refresh_token_encrypted
│       ├── users.email_encrypted
│       ├── sessions.ip_address_encrypted
│       └── invitations.email_encrypted
│
├── SUPABASE_SECRET_KEY (Backend access to Supabase)
│   └── Allows bypass of RLS for backend operations
│
├── R2_SQL_TOKEN (Access to R2 Data Lake)
│   └── Required for all R2 SQL queries
│
└── OAuth Secrets (Platform-specific)
    ├── GOOGLE_CLIENT_SECRET
    ├── FACEBOOK_APP_SECRET
    └── TIKTOK_CLIENT_SECRET
```

#### Security Boundaries
1. **Authentication:** All in D1, sessions never leave
2. **OAuth Tokens:** Encrypted in D1, decrypted only in worker memory
3. **Multi-tenancy:** Enforced at every database level
4. **Audit Trail:** Complete logging in D1 audit tables
5. **Rate Limiting:** Per-user/IP/org limits in D1

### 5. SOC 2 Compliance Features

#### Audit Logging (Complete Trail)
- Every API request → `audit_logs`
- Auth events → `auth_audit_logs`
- Data access → `data_access_logs`
- Config changes → `config_audit_logs`
- Security incidents → `security_events`

#### Data Retention
- Audit logs: 365 days minimum
- Config changes: 730 days
- Security events: 1095 days
- Automated cleanup via scheduled jobs

#### Security Controls
- Rate limiting: 100 req/min standard, 5 failed auth/15min
- Security headers: HSTS, CSP, X-Frame-Options
- Input sanitization: SQL injection protection
- Field encryption: AES-256-GCM for sensitive data

### 6. Monitoring & Health

#### Health Endpoints
```bash
# API Worker
curl https://api.clearlift.ai/v1/health

# Cron Worker
curl https://clearlift-cron-worker.paul-33c.workers.dev/health

# Queue Consumer
curl https://clearlift-queue-consumer.paul-33c.workers.dev/health

# Worker Status from API
curl -H "Authorization: Bearer TOKEN" \
  https://api.clearlift.ai/v1/workers/health
```

#### Key Metrics
- API response times (tracked in audit_logs)
- Sync job success rate (sync_jobs table)
- Failed jobs (dead letter queue)
- Rate limit violations (security_events)
- Authentication failures (auth_audit_logs)

### 7. Disaster Recovery & Backups

#### D1 Database Durability

D1 has **built-in durability** - no manual backup needed:

| Feature | Description |
|---------|-------------|
| **5x Sync Replication** | Every write replicated to 5 servers across different datacenters before commit |
| **Time Travel** | 30-day point-in-time recovery (Workers Paid) |
| **WAL Cold Storage** | Full write history stored, enabling reconstruction anywhere |

#### Time Travel (Point-in-Time Recovery)

```bash
# Get bookmark for a specific timestamp
npx wrangler d1 time-travel info DB --timestamp="2025-12-11T12:00:00Z"

# Restore to a timestamp
npx wrangler d1 time-travel restore DB --timestamp="2025-12-11T12:00:00Z"

# Restore to a bookmark
npx wrangler d1 time-travel restore DB --bookmark=<bookmark-id>
```

**Key points:**
- Restore to any minute within 30 days
- No storage cost for backups
- Restoring doesn't delete older bookmarks (can undo a restore)

#### Pre-Deployment Bookmarks

`npm run deploy` automatically captures a bookmark before migrations:

```
deployments.json
├── timestamp: "2025-12-11T16:18:52.083Z"
├── bookmark: "00001a62-..."
├── gitCommit: "3f9aff2"
└── gitBranch: "main"
```

#### Long-term Backups (Beyond 30 Days)

For archival beyond 30 days, export to R2:
- Use [Cloudflare Workflows](https://developers.cloudflare.com/workflows/examples/backup-d1/)
- Manual JSON exports in `backups/` directory

### 8. Data Privacy & Compliance

#### PII Handling
- **D1:** PII encrypted before storage
- **Supabase:** No PII, only campaign data
- **R2:** Anonymous IDs only, no emails

#### Data Isolation
- **D1:** Organization-based filtering
- **Supabase:** RLS by organization_id
- **R2:** Partitioned by org_tag

#### Right to Deletion
- Soft deletes with deleted_at timestamps
- Hard delete after retention period
- Audit trail preserved for compliance

## Summary

**Total Components:**
- 3 Workers (API, Cron, Queue)
- 3 Databases (D1, Supabase, R2)
- 1 Queue system (Cloudflare Queues)
- Multiple encryption keys

**Security Layers:**
- Field-level encryption (AES-256-GCM)
- TLS 1.3 in transit
- Multi-tenant isolation
- Complete audit trail
- Rate limiting
- Security headers

**Disaster Recovery:**
- D1: 5x sync replication + 30-day Time Travel
- Pre-deployment bookmarks captured automatically
- Point-in-time recovery to any minute

**Compliance:**
- SOC 2 Type 2 ready
- GDPR compliant
- Full audit trail
- Data retention policies
- Encryption at rest and in transit

This architecture ensures **security**, **scalability**, and **compliance** while maintaining clear separation of concerns across all components.