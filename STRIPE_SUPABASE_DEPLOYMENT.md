# Stripe Connector - Supabase Deployment Guide

## Overview
The Stripe connector stores all revenue and metadata in Supabase (PostgreSQL) instead of D1. This provides better querying capabilities for JSONB metadata and centralizes all connector data.

## Step 1: Deploy Supabase Tables

Run the migration script in your Supabase SQL editor:

1. Go to your Supabase dashboard
2. Navigate to SQL Editor
3. Create a new query
4. Copy and paste the contents of `supabase/migrations/stripe_tables.sql`
5. Run the query

This creates:
- `stripe_revenue_data` - Transaction records with JSONB metadata
- `stripe_daily_aggregates` - Pre-computed daily summaries
- `connector_filter_rules` - User-defined filter configurations
- `stripe_metadata_keys` - Discovered metadata field cache
- `stripe_sync_state` - Sync progress tracking
- Several helper functions and views

## Step 2: Update Environment Variables

Add your Supabase service role key to Cloudflare Workers:

```bash
# Add the service role key (found in Supabase Dashboard > Settings > API)
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Verify your `wrangler.jsonc` has the Supabase URL:
```json
{
  "vars": {
    "SUPABASE_URL": "https://YOUR_PROJECT.supabase.co"
  }
}
```

## Step 3: Update Code to Use Supabase Adapter

The codebase now uses two adapters:
- `StripeAdapter` (D1) - Original implementation
- `StripeSupabaseAdapter` (Supabase) - New implementation

To use Supabase, update imports in:

### `src/queue/syncJobProcessor.ts`
```typescript
// Change from:
import { StripeAdapter } from '../adapters/platforms/stripe';

// To:
import { StripeSupabaseAdapter } from '../adapters/platforms/stripe-supabase';
import { SupabaseClient } from '../services/supabase';

// In syncStripe method:
const supabase = new SupabaseClient({
  url: this.env.SUPABASE_URL,
  serviceKey: this.env.SUPABASE_SERVICE_ROLE_KEY!
});
const adapter = new StripeSupabaseAdapter(supabase);
```

### Analytics Endpoints
Update `src/endpoints/v1/analytics/stripe.ts` to query Supabase instead of D1.

## Step 4: Test the Connection

1. Connect a Stripe account:
```bash
curl -X POST https://api.clearlift.ai/v1/connectors/stripe/connect \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "organization_id": "YOUR_ORG_ID",
    "api_key": "sk_test_..."
  }'
```

2. Create a filter rule:
```bash
curl -X POST https://api.clearlift.ai/v1/connectors/{CONNECTION_ID}/filters \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Premium Customers",
    "operator": "AND",
    "conditions": [
      {
        "type": "metadata",
        "metadata_source": "charge",
        "metadata_key": "customer_tier",
        "operator": "equals",
        "value": "premium"
      }
    ]
  }'
```

3. Trigger a sync:
```bash
curl -X POST https://api.clearlift.ai/v1/connectors/stripe/{CONNECTION_ID}/sync \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sync_type": "full"
  }'
```

## Key Differences from D1 Implementation

### JSONB vs TEXT
- **D1**: Metadata stored as TEXT (JSON strings)
- **Supabase**: Metadata stored as JSONB (native PostgreSQL JSON)

### Querying
- **D1**: `json_extract()` function
- **Supabase**: Native JSONB operators (`@>`, `?`, `->`, etc.)

### Performance
- **D1**: Good for simple queries, limited aggregation
- **Supabase**: Better for complex metadata queries, full SQL capabilities

## Metadata Filtering Examples

### Query by metadata in Supabase:
```sql
-- Find all charges with specific metadata
SELECT * FROM stripe_revenue_data
WHERE charge_metadata @> '{"customer_tier": "premium"}';

-- Query nested metadata
SELECT * FROM stripe_revenue_data
WHERE charge_metadata -> 'order' ->> 'type' = 'subscription';

-- Check if metadata key exists
SELECT * FROM stripe_revenue_data
WHERE charge_metadata ? 'campaign_id';

-- Aggregate by metadata value
SELECT
  charge_metadata->>'customer_tier' as tier,
  SUM(amount) as total_revenue
FROM stripe_revenue_data
WHERE status = 'succeeded'
GROUP BY tier;
```

## Monitoring

Check sync status:
```sql
SELECT * FROM stripe_sync_state
WHERE connection_id = 'YOUR_CONNECTION_ID';
```

View discovered metadata keys:
```sql
SELECT DISTINCT object_type, key_path
FROM stripe_metadata_keys
WHERE connection_id = 'YOUR_CONNECTION_ID'
ORDER BY occurrence_count DESC;
```

## Troubleshooting

1. **"Supabase query failed" errors**
   - Check service role key is correct
   - Verify RLS policies or disable RLS for testing

2. **Metadata not filtering correctly**
   - Check metadata is stored as JSONB, not string
   - Verify filter syntax matches PostgreSQL JSONB operators

3. **Sync not finding charges**
   - Check Stripe API key has correct permissions
   - Verify date ranges in sync configuration

## Benefits of Supabase Storage

1. **Better metadata queries** - Native JSONB support with indexes
2. **Scalability** - PostgreSQL handles large datasets better
3. **Advanced analytics** - Full SQL with CTEs, window functions, etc.
4. **Real-time subscriptions** - Can add real-time updates later
5. **Unified storage** - All connector data in one place