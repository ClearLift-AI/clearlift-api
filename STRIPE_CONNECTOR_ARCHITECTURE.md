# Stripe Connector Architecture

## Overview

The Stripe connector follows the same architecture as other connectors (Google Ads, Facebook Ads) with a key difference: it uses **API key authentication** instead of OAuth.

## Architecture Separation

### API Worker (This Project) - api.clearlift.ai

**Responsibilities:**
- Handle Stripe API key submission from users
- Validate API key with Stripe
- Store encrypted API key in D1 `platform_connections` table
- Manage filter rules configuration in D1 `connector_filter_rules`
- Create initial sync job in D1 `sync_jobs`
- Provide analytics endpoints that query data from Supabase

**What it does NOT do:**
- Does not fetch data from Stripe API
- Does not process/transform Stripe data
- Does not write to Supabase

### Cron Worker (Separate Project)

**Responsibilities:**
- Runs every 15 minutes
- Finds Stripe connections due for sync
- Creates sync job records in D1
- Enqueues messages to Cloudflare Queue

### Queue Consumer Worker (Separate Project)

**Responsibilities:**
- Consumes sync job messages from queue
- Decrypts Stripe API key from D1
- Fetches charges/revenue data from Stripe API
- Applies filter rules (reads from D1)
- Transforms data with metadata preservation
- Writes to Supabase tables
- Updates sync status in D1

## Data Storage

### D1 (SQLite) - Configuration & Metadata

```sql
-- Connection configuration
platform_connections (
  id,                        -- org_id-stripe-account_id
  credentials_encrypted,     -- Encrypted API key
  stripe_account_id,         -- Stripe account identifier
  stripe_livemode,           -- true for live, false for test
  filter_rules_count         -- Number of active filter rules
)

-- Filter rules configuration
connector_filter_rules (
  id,
  connection_id,
  name,
  conditions,                -- JSON array of filter conditions
  is_active
)

-- Sync job tracking
sync_jobs (
  id,
  connection_id,
  status,                    -- pending|running|completed|failed
  job_type,                  -- full|incremental
  metadata                   -- Contains Stripe-specific config
)
```

### Supabase (PostgreSQL) - Revenue Data

```sql
-- Stripe transaction data with metadata
stripe_revenue_data (
  id,
  connection_id,
  organization_id,
  date,
  charge_id,
  amount,
  currency,
  -- JSONB metadata fields for flexible querying
  charge_metadata,           -- User-defined metadata from charge
  product_metadata,          -- User-defined metadata from product
  price_metadata,            -- User-defined metadata from price
  customer_metadata          -- User-defined metadata from customer
)

-- Daily aggregates for performance
stripe_daily_aggregates (
  connection_id,
  date,
  total_revenue,
  total_units,
  revenue_by_product,        -- JSONB
  top_metadata_values        -- JSONB
)

-- Metadata discovery
stripe_metadata_keys (
  connection_id,
  object_type,               -- charge|product|price|customer
  key_path,                  -- Discovered metadata keys
  sample_values
)

-- Sync state tracking
stripe_sync_state (
  connection_id,
  last_charge_id,
  next_sync_from,
  total_revenue_synced
)
```

## API Endpoints

### Connection Management (API Worker)

```typescript
// Connect Stripe account
POST /v1/connectors/stripe/connect
{
  "organization_id": "org_123",
  "api_key": "sk_test_...",
  "lookback_days": 30
}
→ Validates API key
→ Stores encrypted in D1
→ Creates initial sync job
→ Returns connection_id

// Test connection
POST /v1/connectors/stripe/{connection_id}/test
→ Validates API key still works
→ Returns account info

// Trigger manual sync
POST /v1/connectors/stripe/{connection_id}/sync
→ Creates sync job in D1
→ Returns job_id
```

### Filter Management (API Worker)

```typescript
// Create filter rule
POST /v1/connectors/{connection_id}/filters
{
  "name": "Premium Customers",
  "operator": "AND",
  "conditions": [
    {
      "type": "metadata",
      "metadata_source": "charge",
      "metadata_key": "customer_tier",  // Any user-defined key
      "operator": "equals",
      "value": "premium"
    }
  ]
}
→ Stores in D1
→ Queue consumer reads and applies during sync

// Discover metadata keys
GET /v1/connectors/{connection_id}/filters/discover
→ Queries Supabase for discovered metadata keys
→ Returns available keys for filtering
```

### Analytics (API Worker)

```typescript
// Query Stripe revenue data
GET /v1/analytics/stripe?connection_id=xxx&date_from=2024-01-01
→ Queries Supabase (NOT D1)
→ Applies metadata filters using JSONB operators
→ Returns aggregated revenue data

// Get daily aggregates
GET /v1/analytics/stripe/daily-aggregates?connection_id=xxx
→ Queries pre-computed aggregates from Supabase
→ Fast performance for dashboards
```

## Data Flow

```
1. User submits Stripe API key
   → API Worker validates and encrypts
   → Stores in D1 platform_connections
   → Creates initial sync job

2. Cron Worker (every 15 min)
   → Reads connection from D1
   → Creates sync job
   → Enqueues to Cloudflare Queue

3. Queue Consumer
   → Decrypts API key from D1
   → Fetches data from Stripe API
   → Reads filter rules from D1
   → Applies filters to data
   → Writes filtered data to Supabase
   → Updates sync status in D1

4. User queries analytics
   → API Worker queries Supabase
   → Returns aggregated data
```

## Metadata Filtering

The Stripe connector's key feature is filtering on arbitrary user-defined metadata:

### Example Metadata Structure

```json
// Charge metadata (user-defined)
{
  "customer_tier": "premium",
  "campaign_id": "summer-2024",
  "order_type": "subscription",
  "internal_ref": "ORD-12345"
}

// Product metadata (user-defined)
{
  "category": "saas",
  "billing_model": "recurring",
  "feature_tier": "pro"
}
```

### Filter Examples

```typescript
// Filter by any metadata field
{
  "type": "metadata",
  "metadata_source": "charge",
  "metadata_key": "customer_tier",  // User's custom field
  "operator": "equals",
  "value": "premium"
}

// Complex nested metadata
{
  "type": "metadata",
  "metadata_source": "product",
  "metadata_key": "billing.model",  // Nested path
  "operator": "in",
  "value": ["recurring", "subscription"]
}
```

## Security

### API Key Storage
- Encrypted using AES-256-GCM in D1
- Same encryption key shared across all workers
- Only Queue Consumer decrypts for API calls

### Multi-tenancy
- All Supabase tables filtered by `organization_id`
- RLS policies enforce organization boundaries
- API Worker can only read data for authenticated org

## Implementation Status

### ✅ Completed (API Worker)
- Database migrations for D1 configuration tables
- Stripe connection endpoint
- Filter management endpoints
- Analytics endpoints
- Supabase table definitions

### ⏳ Queue Consumer Needs
- Stripe API client implementation
- Filter application logic
- Data transformation to Supabase schema
- Metadata discovery and indexing

## Key Differences from OAuth Connectors

1. **Authentication**: API key instead of OAuth flow
2. **No token refresh**: API keys don't expire
3. **Metadata focus**: Primary feature is filtering on user-defined metadata
4. **Flexible schema**: JSONB columns for arbitrary metadata

## Testing

### Local Testing (API Worker)
```bash
# Connect Stripe
curl -X POST http://localhost:8787/v1/connectors/stripe/connect \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"organization_id": "org_123", "api_key": "sk_test_..."}'

# Create filter
curl -X POST http://localhost:8787/v1/connectors/CONNECTION_ID/filters \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"name": "Test Filter", "conditions": [...]}'

# Check sync status
curl http://localhost:8787/v1/connectors/CONNECTION_ID/sync-status \
  -H "Authorization: Bearer SESSION_TOKEN"
```

### Verify Data Flow
1. API Worker stores connection → Check D1
2. Wait 15 min for cron → Check sync_jobs created
3. Queue consumer runs → Check Supabase tables populated
4. Query analytics → Verify filtered data returned

## Notes for Queue Consumer Implementation

When implementing Stripe sync in the queue consumer:

1. **Read filter rules from D1** before fetching from Stripe
2. **Apply filters during fetch** to minimize API calls
3. **Preserve all metadata** as JSONB in Supabase
4. **Update metadata_keys table** for discovery
5. **Handle pagination** for large charge volumes
6. **Respect rate limits** (100 req/sec for Stripe)