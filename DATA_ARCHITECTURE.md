# ClearLift API - Data Architecture & Storage

## Overview

ClearLift API uses a multi-tier data architecture with three primary storage systems, each optimized for different data access patterns.

---

## 1. Cloudflare D1 (Primary Operational Database)

### Location
- **Type**: SQLite-based serverless SQL database
- **Database ID**: `89bd84be-b517-4c72-ab61-422384319361`
- **Database Name**: `ClearLiftDash-D1`
- **Region**: Cloudflare global edge network
- **Access**: Via Workers binding `c.env.DB`

### Storage Format
- **Engine**: SQLite (SQL)
- **Row Format**: Traditional relational tables
- **Character Encoding**: UTF-8
- **Date Format**: ISO 8601 strings (`YYYY-MM-DDTHH:MM:SSZ`)
- **JSON Fields**: Stored as TEXT, parsed in application

### Tables & Data Types

#### `users` - User accounts
```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,              -- UUID
    email TEXT NOT NULL,              -- Plaintext (PII) - candidate for encryption
    email_encrypted TEXT,             -- AES-GCM encrypted email
    email_hash TEXT,                  -- SHA-256 hash for lookups
    issuer TEXT NOT NULL,             -- Cloudflare Access issuer URL
    access_sub TEXT NOT NULL,         -- CF Access subject ID
    identity_nonce TEXT,              -- Random nonce (candidate for encryption)
    created_at TEXT DEFAULT NOW,      -- ISO 8601 timestamp
    last_login_at TEXT,               -- ISO 8601 timestamp
    name TEXT,                        -- Display name
    avatar_url TEXT,                  -- URL to avatar image
    updated_at DATETIME,              -- Last update timestamp
    UNIQUE (issuer, access_sub)
);
```

**Data Classification**:
- 🔴 **PII**: `email`, `name`
- 🟡 **Auth Secrets**: `identity_nonce`, `access_sub`
- 🟢 **Public**: `avatar_url`, `created_at`

#### `sessions` - Active user sessions
```sql
CREATE TABLE sessions (
    token TEXT PRIMARY KEY,           -- UUID session token
    user_id TEXT NOT NULL,            -- FK to users.id
    created_at DATETIME DEFAULT NOW,  -- Session start
    expires_at DATETIME NOT NULL,     -- Expiration time
    ip_address TEXT,                  -- Client IP (PII) - candidate for encryption
    ip_address_encrypted TEXT,        -- Encrypted IP
    user_agent TEXT,                  -- Browser user agent
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

**Data Classification**:
- 🔴 **PII**: `ip_address`
- 🟡 **Auth Secrets**: `token`
- 🟢 **Metadata**: `user_agent`, `created_at`

#### `organizations` - Workspaces/accounts
```sql
CREATE TABLE organizations (
    id TEXT PRIMARY KEY,              -- UUID
    name TEXT NOT NULL,               -- Organization name
    slug TEXT UNIQUE NOT NULL,        -- URL-friendly identifier
    created_at DATETIME DEFAULT NOW,
    updated_at DATETIME DEFAULT NOW,
    settings TEXT DEFAULT '{}',       -- JSON object (may contain billing info)
    subscription_tier TEXT DEFAULT 'free'  -- free|pro|enterprise
);
```

**Example `settings` JSON**:
```json
{
  "branding": {
    "logo_url": "https://...",
    "primary_color": "#007bff"
  },
  "billing": {
    "stripe_customer_id": "cus_...",  // Sensitive!
    "plan_id": "price_..."
  },
  "features": {
    "api_access": true,
    "export_enabled": true
  }
}
```

#### `organization_members` - User-org relationships
```sql
CREATE TABLE organization_members (
    organization_id TEXT NOT NULL,    -- FK to organizations.id
    user_id TEXT NOT NULL,            -- FK to users.id
    role TEXT NOT NULL,               -- viewer|admin|owner
    joined_at DATETIME DEFAULT NOW,
    invited_by TEXT,                  -- FK to users.id (nullable)
    PRIMARY KEY (organization_id, user_id)
);
```

#### `platform_connections` - OAuth connections to ad platforms
```sql
CREATE TABLE platform_connections (
    id TEXT PRIMARY KEY,              -- "{org_id}-{platform}-{account_id}"
    organization_id TEXT NOT NULL,    -- FK to organizations.id
    platform TEXT NOT NULL,           -- google|facebook|tiktok|etc
    account_id TEXT NOT NULL,         -- Platform-specific account ID
    account_name TEXT,                -- Human-readable account name
    connected_by TEXT NOT NULL,       -- FK to users.id
    connected_at DATETIME DEFAULT NOW,
    last_synced_at DATETIME,
    sync_status TEXT DEFAULT 'pending',  -- pending|syncing|success|error
    sync_error TEXT,                  -- Error message if sync failed
    is_active INTEGER DEFAULT 1,      -- Boolean (0|1)
    settings TEXT DEFAULT '{}',       -- JSON (contains OAuth tokens!)
    settings_encrypted TEXT,          -- Encrypted OAuth credentials
    UNIQUE(organization_id, platform, account_id)
);
```

**Example `settings` JSON (HIGHLY SENSITIVE)**:
```json
{
  "oauth": {
    "access_token": "ya29.a0AfH6...",     // SENSITIVE!
    "refresh_token": "1//0gX...",         // SENSITIVE!
    "expires_at": "2025-10-10T12:00:00Z",
    "scope": "ads.readonly"
  },
  "sync_config": {
    "lookback_days": 30,
    "include_keywords": true,
    "include_ad_groups": true
  }
}
```

#### `org_tag_mappings` - Organization to data tag mapping
```sql
CREATE TABLE org_tag_mappings (
    id TEXT PRIMARY KEY,              -- UUID
    organization_id TEXT NOT NULL,    -- FK to organizations.id
    short_tag TEXT UNIQUE NOT NULL,   -- Short identifier (e.g., "a3f7c2")
    is_active BOOLEAN DEFAULT TRUE,   -- Enable/disable tag
    created_at DATETIME DEFAULT NOW,
    updated_at DATETIME DEFAULT NOW,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
```

**Purpose**: Maps organizations to their data partition tag in R2 SQL.
- Used as `WHERE org_tag = 'a3f7c2'` in analytics queries
- Enables multi-tenancy without exposing org IDs

#### `invitations` - Pending organization invitations
```sql
CREATE TABLE invitations (
    id TEXT PRIMARY KEY,              -- UUID
    organization_id TEXT NOT NULL,    -- FK to organizations.id
    email TEXT NOT NULL,              -- Invitee email (PII)
    email_encrypted TEXT,             -- Encrypted email
    email_hash TEXT,                  -- Hash for lookups
    token TEXT UNIQUE NOT NULL,       -- UUID invitation token
    expires_at DATETIME NOT NULL,     -- Expiration time
    created_at DATETIME DEFAULT NOW,
    invited_by TEXT NOT NULL          -- FK to users.id
);
```

### Data at Rest Encryption

**Current State**: Cloudflare D1 provides encryption at rest by default, but data is readable to anyone with database access.

**Recommended Enhancement**: Field-level encryption for PII using AES-256-GCM:
- Encrypted fields: `email`, `ip_address`, `settings` (OAuth tokens)
- Implementation: See `ENCRYPTION_IMPLEMENTATION_GUIDE.md`

---

## 2. Supabase PostgreSQL (Ad Platform Data)

### Location
- **Type**: PostgreSQL (via Supabase)
- **URL**: `https://jwosqxmfezmnhrbbjlbx.supabase.co`
- **Region**: Likely US-East (check Supabase dashboard)
- **Access**: Via Supabase client library or PostgREST API

### Storage Format
- **Engine**: PostgreSQL 15+
- **Row Format**: Heap-based relational tables
- **Character Encoding**: UTF-8
- **Date Format**: PostgreSQL TIMESTAMP WITH TIME ZONE
- **Encryption**: AES-256 at rest (Supabase managed)

### Tables & Data Types

Tables are defined in `migrations-ad-data/`:

#### `campaigns` - Ad campaign metadata
```sql
CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,              -- Platform campaign ID
    org_id TEXT NOT NULL,             -- FK to D1 organizations.id
    platform TEXT NOT NULL,           -- google|facebook|tiktok
    account_id TEXT NOT NULL,         -- Platform account ID
    name TEXT NOT NULL,               -- Campaign name
    status TEXT,                      -- active|paused|ended
    budget DECIMAL(10,2),             -- Daily/lifetime budget
    spend DECIMAL(10,2),              -- Total spend
    impressions INTEGER,              -- Total impressions
    clicks INTEGER,                   -- Total clicks
    conversions INTEGER,              -- Total conversions
    created_at TIMESTAMP,             -- Campaign created time
    updated_at TIMESTAMP,             -- Last synced time
    raw_data JSONB                    -- Full platform response
);
```

#### `ad_groups` - Ad group level data
```sql
CREATE TABLE ad_groups (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,        -- FK to campaigns.id
    org_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    name TEXT,
    status TEXT,
    bid_amount DECIMAL(10,4),
    -- metrics...
);
```

#### `keywords` - Search keywords (Google/Bing)
```sql
CREATE TABLE keywords (
    id TEXT PRIMARY KEY,
    ad_group_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    text TEXT NOT NULL,               -- Keyword text
    match_type TEXT,                  -- exact|phrase|broad
    bid DECIMAL(10,4),
    quality_score INTEGER,
    -- metrics...
);
```

### Data Access Pattern
- **Write**: Synced from ad platforms via ClearLift sync worker
- **Read**: Queried via API endpoint `/v1/analytics/ads/:platform_slug`
- **Updates**: Periodic sync (hourly/daily depending on tier)

### Encryption
Supabase provides:
- ✅ Encryption at rest (AES-256)
- ✅ Encrypted backups
- ✅ TLS in transit
- ❌ Field-level encryption (would need application-level implementation)

---

## 3. R2 SQL (Analytics Events - Iceberg Tables)

### Location
- **Type**: Cloudflare R2 Object Storage + SQL query interface
- **Bucket**: `clearlift-prod`
- **Account ID**: `133c285e1182ce57a619c802eaf56fb0`
- **Region**: Auto (Cloudflare global)
- **Query Endpoint**: `https://api.sql.cloudflarestorage.com/api/v1/accounts/{account_id}/r2-sql/query/{bucket}`

### Storage Format
- **Data Format**: Apache Iceberg tables
- **File Format**: Apache Parquet (columnar)
- **Partitioning**: By `org_tag` and date
- **Character Encoding**: UTF-8
- **Compression**: Snappy (default for Parquet)
- **Encryption**: AES-256 server-side encryption (R2 managed)

### Schema

#### `clearlift.events` - All user events
Stored as Parquet files with schema defined in `src/adapters/platforms/r2sql.ts`:

```typescript
interface EventRecord {
  // Partitioning keys
  org_tag: string,                    // Organization identifier
  timestamp: string,                  // ISO 8601 timestamp

  // Session identifiers
  session_id: string,                 // Session UUID
  user_id?: string | null,            // Authenticated user ID (PII)
  anonymous_id: string,               // Anonymous tracking ID

  // Event metadata
  event_id: string,                   // Unique event UUID
  event_type: string,                 // page_view|click|conversion|etc
  event_data?: string | null,         // JSON string of custom data
  event_category?: string | null,     // E.g., "ecommerce"
  event_action?: string | null,       // E.g., "purchase"
  event_label?: string | null,        // E.g., "product_id_123"
  event_value?: number | null,        // Numeric value (revenue, etc)

  // Page context
  page_url: string,                   // Full URL
  page_title: string,                 // Page title
  page_path: string,                  // URL path
  page_hostname: string,              // Domain
  page_search?: string | null,        // Query string
  page_hash?: string | null,          // URL hash
  referrer?: string | null,           // Referrer URL
  referrer_domain?: string | null,    // Referrer domain

  // Device/browser (PII adjacent)
  device_type: string,                // mobile|desktop|tablet
  viewport_width: number,
  viewport_height: number,
  screen_width?: number | null,
  screen_height?: number | null,
  browser_name: string,               // Chrome|Firefox|Safari
  browser_version?: string | null,
  browser_language: string,           // en-US
  os_name?: string | null,            // Windows|macOS|iOS|Android
  os_version?: string | null,
  user_agent?: string | null,         // Full user agent (PII)

  // Geo data (PII - derived from IP)
  geo_country?: string | null,        // US
  geo_region?: string | null,         // California
  geo_city?: string | null,           // San Francisco
  geo_timezone?: string | null,       // America/Los_Angeles

  // UTM parameters (marketing attribution)
  utm_source?: string | null,         // google|facebook|newsletter
  utm_medium?: string | null,         // cpc|email|social
  utm_campaign?: string | null,       // spring_sale_2025
  utm_term?: string | null,           // keyword
  utm_content?: string | null,        // ad_variant_a

  // Ad click IDs (for attribution)
  gclid?: string | null,              // Google Click ID
  fbclid?: string | null,             // Facebook Click ID

  // Performance metrics
  scroll_depth?: number | null,       // Percentage
  engagement_time?: number | null,    // Seconds
  page_load_time?: number | null,     // Milliseconds
  ttfb?: number | null,               // Time to first byte
  dom_content_loaded?: number | null,
  first_contentful_paint?: number | null,
  largest_contentful_paint?: number | null,

  // Privacy/consent
  consent_analytics: boolean,         // User consented to analytics
  consent_marketing?: boolean | null  // User consented to marketing
}
```

### File Organization

```
s3://clearlift-prod/
└── data/
    └── events/
        ├── org_tag=a3f7c2/
        │   ├── year=2025/
        │   │   ├── month=10/
        │   │   │   ├── day=10/
        │   │   │   │   └── events-{uuid}.parquet  (1GB chunks)
        │   │   │   └── day=11/
        │   │   │       └── events-{uuid}.parquet
        │   │   └── month=11/
        │   └── year=2024/
        └── org_tag=b8e9d1/
            └── year=2025/
                └── ...
```

### Query Limitations (R2 SQL)
R2 SQL is optimized for scans, not complex queries:

**Supported**:
✅ `SELECT * WHERE org_tag = 'xxx' AND timestamp > '...'`
✅ `LIMIT` and `OFFSET`
✅ `WHERE` filters on columns
✅ Basic `IN` clauses

**NOT Supported**:
❌ `GROUP BY` (must aggregate client-side)
❌ `DISTINCT`
❌ `COUNT()`, `SUM()`, `AVG()` aggregations
❌ `ORDER BY` (except on partition keys)
❌ `JOIN` operations
❌ Subqueries

**Workaround**: Fetch raw data with filters, aggregate in application code (see `R2SQLAdapter.calculateSummary()`).

### Data Access Pattern
- **Write**: Events sent from client-side tracking script → Worker → R2 (via Iceberg writer)
- **Read**: API queries via `/v1/analytics/events` → R2 SQL REST API
- **Retention**: Configurable (e.g., 90 days rolling window)

### Encryption & Privacy
- ✅ Encryption at rest (R2 AES-256)
- ✅ TLS in transit
- ⚠️ **IP addresses not stored** (only derived geo data)
- ❌ Field-level encryption (would require custom implementation before writing to R2)

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Applications                     │
│                (Dashboard, Mobile App, etc.)                 │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    │ HTTPS (TLS 1.3)
                    ↓
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Workers API (Hono)                   │
│                    api.clearlift.ai                          │
├─────────────────────────────────────────────────────────────┤
│  • Authentication (JWT + Session validation)                 │
│  • Authorization (Org membership checks)                     │
│  • Rate limiting (Cloudflare)                                │
│  • Field-level encryption (optional)                         │
└┬────────────┬────────────────────────────────────┬──────────┘
 │            │                                    │
 │ D1 Binding │ Supabase Client                    │ R2 SQL API
 ↓            ↓                                    ↓
┌──────────┐ ┌────────────────┐ ┌────────────────────────────┐
│ D1 (SQL) │ │ Supabase (PG)  │ │   R2 SQL (Iceberg)         │
├──────────┤ ├────────────────┤ ├────────────────────────────┤
│ Users    │ │ Campaigns      │ │ Events (Parquet files)     │
│ Sessions │ │ Ad Groups      │ │ • Partitioned by org_tag   │
│ Orgs     │ │ Keywords       │ │ • Compressed (Snappy)      │
│ Platform │ │ Sync History   │ │ • Columnar storage         │
│ Tags     │ │                │ │ • Auto-sharded             │
└──────────┘ └────────────────┘ └────────────────────────────┘
    │              │                        │
    ↓              ↓                        ↓
┌──────────────────────────────────────────────────────────────┐
│           Cloudflare Encryption Layer (AES-256)              │
│  D1: Encrypted at rest (SQLite file)                         │
│  R2: Server-side encryption (per object)                     │
│  Supabase: Database encryption (PostgreSQL TDE)              │
└──────────────────────────────────────────────────────────────┘
```

---

## Encryption Summary

| Storage Layer | Encryption at Rest | TLS in Transit | Field-Level Encryption | Who Holds Keys |
|---------------|-------------------|----------------|------------------------|----------------|
| **D1** | ✅ AES-256 (CF managed) | ✅ TLS 1.3 | ⚠️ Optional (app-level) | Cloudflare |
| **Supabase** | ✅ AES-256 (Supabase managed) | ✅ TLS 1.3 | ❌ Not implemented | Supabase |
| **R2 SQL** | ✅ AES-256 (CF managed) | ✅ TLS 1.3 | ❌ Not implemented | Cloudflare |

### Current Protection Level
- ✅ Protected against physical disk theft
- ✅ Protected against network sniffing
- ❌ **NOT** protected against database dump/backup exposure
- ❌ **NOT** protected against insider access (Cloudflare/Supabase employees)

### With Field-Level Encryption (Recommended)
- ✅ All of the above
- ✅ Protected against database dumps (encrypted fields are ciphertext)
- ✅ Protected against most insider threats (master key in Secrets Store)
- ⚠️ Still vulnerable if master key is compromised

---

## Compliance Considerations

### GDPR (EU)
- **Data Subject Rights**: Users can request data deletion
  - D1: Delete user row (cascades to sessions, org_members)
  - Supabase: Delete ad data for `org_id`
  - R2: Filter events by `user_id` (manual deletion process)
- **Encryption**: Recommended for PII fields
- **Data Portability**: Export user data via API endpoint

### CCPA (California)
- Similar to GDPR requirements
- Need "Do Not Sell" mechanism if sharing data with third parties
- Currently not sharing data with third parties

### SOC 2 (Future)
- Field-level encryption of PII recommended
- Audit logging of data access
- Key rotation procedures
- Access control reviews

---

## Performance Characteristics

| Operation | D1 | Supabase | R2 SQL |
|-----------|-----|----------|---------|
| Point lookup | <10ms | 50-100ms | N/A (scan-based) |
| Range scan (1K rows) | 20-50ms | 100-200ms | 200-500ms |
| Aggregation (10K rows) | 50-100ms | 200-500ms | 1-2s (client-side) |
| Write (single row) | <5ms | 50-100ms | N/A (batch writes) |
| Batch write (1K rows) | 50-100ms | 500ms-1s | 1-3s (Parquet write) |

**Latency Notes**:
- D1: Edge-replicated, sub-10ms global latency
- Supabase: Single region, ~50ms+ depending on location
- R2 SQL: Global, but optimized for large scans, not point queries

---

## Recommendations

### Immediate (Pre-Launch)
1. ✅ **Implement field-level encryption** for PII in D1
   - `users.email`, `sessions.ip_address`, `platform_connections.settings`
2. ✅ **Use Cloudflare Secrets Store** for encryption keys
3. ✅ **Enable audit logging** in Cloudflare (Workers Logpush)

### Short-Term (First 6 months)
1. **Implement data retention policies**
   - Auto-delete old sessions (>30 days)
   - Archive old analytics events (>90 days to cheaper storage)
2. **Add row-level security** to Supabase
3. **Implement key rotation** strategy

### Long-Term (Production maturity)
1. **SOC 2 compliance** audit
2. **Penetration testing** of encryption implementation
3. **Disaster recovery** procedures for encrypted data
4. **Multi-region replication** (if needed for compliance)

---

For implementation details, see:
- **Encryption**: `ENCRYPTION_IMPLEMENTATION_GUIDE.md`
- **Database Schema**: `migrations/*.sql`
- **API Design**: `CLAUDE.md`
