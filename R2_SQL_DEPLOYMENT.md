# R2 SQL Integration - Deployment Guide

## Changes Made

Successfully replaced DuckDB integration with direct R2 SQL querying for event analytics.

### Files Modified

1. **New Files:**
   - `src/adapters/platforms/r2sql.ts` - R2 SQL adapter with query execution and client-side aggregation
   - `src/endpoints/v1/analytics/schema.ts` - Endpoint to expose 60-field event schema
   - `R2_SQL_DEPLOYMENT.md` - This deployment guide

2. **Updated Files:**
   - `src/types.ts` - Added R2 SQL environment bindings
   - `wrangler.jsonc` - Added R2 SQL configuration
   - `src/endpoints/v1/analytics/conversions.ts` - Updated to use R2SQLAdapter
   - `src/index.ts` - Registered schema endpoint
   - `.env` - Added R2 SQL token documentation
   - `CLAUDE.md` - Updated architecture documentation

### Key Features

- **Direct R2 SQL Querying**: No separate worker needed
- **Client-Side Aggregation**: Handles R2 SQL limitations (no GROUP BY, no aggregation functions)
- **SQL Injection Protection**: Query validation and escaping
- **60-Field Schema**: Comprehensive event schema endpoint

## Deployment Steps

### 1. Set R2 SQL Token Secret

You need to create and set the R2 SQL token in Cloudflare Secrets Store:

```bash
# Create a Cloudflare API token with R2 read permissions at:
# https://dash.cloudflare.com/profile/api-tokens

# Then add it to Secrets Store:
npx wrangler secret put R2_SQL_TOKEN
# Paste your token when prompted
```

### 2. Verify Configuration

Check that wrangler.jsonc has the correct values:
- `CLOUDFLARE_ACCOUNT_ID`: `133c285e1182ce57a619c802eaf56fb0` ✓
- `R2_BUCKET_NAME`: `clearlift-prod` ✓
- `R2_SQL_TOKEN`: Set in Secrets Store (see step 1)

### 3. Deploy

```bash
# Commit changes
git add .
git commit -m "feat: replace DuckDB with R2 SQL direct integration"

# Push to GitHub (will auto-deploy via CI/CD)
git push origin main
```

### 4. Test Endpoints

After deployment, test the new endpoints:

```bash
# Test schema endpoint (public)
curl https://api.clearlift.ai/v1/analytics/schema

# Test conversions endpoint (requires auth)
curl https://api.clearlift.ai/v1/analytics/conversions?org_id=<org-id>&lookback=24h \
  -H "Authorization: Bearer <session-token>"

# Test stats endpoint
curl https://api.clearlift.ai/v1/analytics/stats?org_id=<org-id>&lookback=7d \
  -H "Authorization: Bearer <session-token>"

# Test funnel endpoint
curl https://api.clearlift.ai/v1/analytics/funnel?org_id=<org-id>&steps=page_view,click,conversion \
  -H "Authorization: Bearer <session-token>"
```

## API Changes

### New Endpoint

**GET /v1/analytics/schema**
- Returns 60-field event schema
- No authentication required
- Useful for API documentation and client development

### Updated Endpoints (behavior unchanged for clients)

- **GET /v1/analytics/conversions** - Now queries R2 SQL instead of DuckDB
- **GET /v1/analytics/stats** - Now queries R2 SQL instead of DuckDB
- **GET /v1/analytics/funnel** - Now queries R2 SQL instead of DuckDB

All endpoints maintain the same request/response format, ensuring backward compatibility.

## R2 SQL Adapter Capabilities

### Supported Operations

- ✅ **SELECT queries** with field selection
- ✅ **WHERE filters** (equality, IN, comparisons)
- ✅ **Time-based filtering** (lookback or absolute range)
- ✅ **LIMIT and OFFSET** for pagination
- ✅ **Client-side aggregation** (GROUP BY, COUNT, DISTINCT)
- ✅ **Client-side sorting** by timestamp

### Limitations

- ❌ No server-side GROUP BY
- ❌ No aggregation functions (COUNT, SUM, AVG)
- ❌ No DISTINCT on server
- ❌ No ORDER BY (except on partition keys)
- ❌ No JOINs

### Workarounds

All aggregations are performed client-side in the R2SQLAdapter:
- Fetches raw data with filters
- Aggregates in memory using JavaScript
- Recommended limit: 10,000 rows for aggregation queries

## Monitoring

Watch for these potential issues:

1. **Performance**: If aggregation queries are slow, reduce the lookback period or limit
2. **Memory**: Large result sets (>10k rows) may cause memory issues
3. **R2 SQL API errors**: Check for rate limits or authentication failures

View logs:
```bash
npx wrangler tail
```

## Rollback Plan

If issues arise, you can rollback to the previous DuckDB implementation:

```bash
git revert HEAD
git push origin main
```

Note: You'll need to ensure the DuckDB worker at query.clearlift.ai is operational.

## Next Steps

1. Monitor performance after deployment
2. Consider implementing caching for frequently accessed aggregations
3. Add more sophisticated client-side aggregation if needed
4. Implement pagination for large result sets
5. Add query result caching (KV or R2) for expensive aggregations

## Support

For issues with R2 SQL integration:
- Check Cloudflare R2 SQL documentation
- Review API logs with `npx wrangler tail`
- Test queries directly against R2 SQL API for debugging