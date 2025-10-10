# R2 SQL Diagnostic Report

## Test Results

**Date:** 2025-10-10
**Status:** ❌ No tables found

## Configuration

- **Account ID:** `133c285e1182ce57a619c802eaf56fb0`
- **Bucket Name:** `clearlift-db`
- **Warehouse Name:** `133c285e1182ce57a619c802eaf56fb0_clearlift-db`
- **Catalog URI:** `https://catalog.cloudflarestorage.com/133c285e1182ce57a619c802eaf56fb0/clearlift-db`
- **Table Name:** `event_stream` (confirmed)
- **API Endpoint:** `https://api.sql.cloudflarestorage.com/api/v1/accounts/133c285e1182ce57a619c802eaf56fb0/r2-sql/query/clearlift-db`

## Error Messages

All queries returned error code `40010`:
```
"iceberg table not found \"default.event_stream\""
"iceberg table not found \"clearlift_db.event_stream\""
"iceberg table not found \"\"clearlift-db\".event_stream\""
```

## Diagnosis

The R2 SQL API is responding (not authentication errors), but **no Iceberg tables are registered** in the catalog.

## Possible Causes

### 1. R2 Data Catalog Not Initialized

The most likely issue is that the R2 Data Catalog hasn't been set up yet. You need to:

**Option A: Use Cloudflare Dashboard**
1. Go to: https://dash.cloudflare.com/[account_id]/r2/buckets
2. Click on `clearlift-db` bucket
3. Go to "Data Catalog" tab
4. Click "Create Catalog" or "Register Table"
5. Register the `event_stream` table

**Option B: Use Wrangler CLI**
```bash
# Create the catalog
npx wrangler r2 catalog create clearlift-db

# Register the event_stream table
npx wrangler r2 catalog register clearlift-db \
  --table-name event_stream \
  --table-location s3://clearlift-db/event_stream
```

**Option C: Use REST API**
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/133c285e1182ce57a619c802eaf56fb0/r2/buckets/clearlift-db/catalog/tables" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "event_stream",
    "format": "iceberg",
    "location": "s3://clearlift-db/event_stream"
  }'
```

### 2. Iceberg Metadata Files Missing

If you're writing Iceberg tables from another system (like Spark, Flink, etc.), ensure the metadata files exist:

**Required Iceberg structure:**
```
s3://clearlift-db/event_stream/
  ├── metadata/
  │   ├── v1.metadata.json
  │   ├── snap-*.avro
  │   └── *.avro
  └── data/
      └── *.parquet
```

Check if these files exist in R2:
```bash
npx wrangler r2 object list clearlift-db --prefix event_stream/metadata/
```

### 3. Incorrect Table Name/Namespace

Even though you confirmed the table is called `event_stream`, double-check:
- Is it in the `default` namespace?
- Could it be in a different schema?
- Check the exact name in the Iceberg metadata

### 4. Permissions Issue

Verify the R2_SQL_TOKEN has these permissions:
- `R2:Read` on bucket `clearlift-db`
- `Data Catalog:Read` on account

Test token permissions:
```bash
curl "https://api.cloudflare.com/client/v4/accounts/133c285e1182ce57a619c802eaf56fb0/r2/buckets/clearlift-db" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Next Steps

### Step 1: Verify Catalog Exists

Go to Cloudflare Dashboard and check if the R2 Data Catalog is visible for `clearlift-db`.

### Step 2: List Buckets and Objects

```bash
# List all R2 buckets
npx wrangler r2 bucket list

# List objects in clearlift-db
npx wrangler r2 object list clearlift-db --limit 20

# Check if event_stream directory exists
npx wrangler r2 object list clearlift-db --prefix event_stream/
```

### Step 3: Check Iceberg Metadata

If `event_stream/` exists, check for Iceberg metadata:
```bash
# List metadata directory
npx wrangler r2 object list clearlift-db --prefix event_stream/metadata/

# Download and inspect metadata file
npx wrangler r2 object get clearlift-db event_stream/metadata/v1.metadata.json
```

### Step 4: Register Table (if metadata exists)

If Iceberg metadata files exist but the table isn't registered:
```bash
npx wrangler r2 catalog register clearlift-db \
  --table-name event_stream \
  --format iceberg
```

### Step 5: Test Query Again

Once the table is registered, run:
```bash
npx tsx test-r2sql.ts
```

## Working Example Query (Once Table is Registered)

Based on typical R2 SQL usage, the query should work as:
```sql
SELECT * FROM event_stream LIMIT 10
```

Or with explicit namespace:
```sql
SELECT * FROM default.event_stream LIMIT 10
```

## Alternative: Direct R2 Object Access

If R2 Data Catalog setup is complex, consider these alternatives:

### Option A: Query via DuckDB Worker
Set up a separate Cloudflare Worker with DuckDB WASM that:
1. Reads Parquet files directly from R2
2. Executes SQL queries in-worker
3. Returns results to API

### Option B: Supabase Storage + DuckDB
Move event data to Supabase Storage and query with Postgres foreign data wrappers.

### Option C: ClickHouse Cloud
Export R2 data to ClickHouse for analytics queries.

## Contact Support

If none of these steps work, contact Cloudflare support with:
- Account ID: `133c285e1182ce57a619c802eaf56fb0`
- Bucket: `clearlift-db`
- Error message: `[40010] iceberg table not found`
- Question: "How do I register an Iceberg table in R2 Data Catalog for SQL querying?"

## References

- [Cloudflare R2 SQL Documentation](https://developers.cloudflare.com/r2/data-catalog/)
- [Iceberg Table Format](https://iceberg.apache.org/docs/latest/)
- [R2 SQL API Reference](https://developers.cloudflare.com/api/operations/r2-sql-query)
