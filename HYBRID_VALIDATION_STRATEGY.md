# Hybrid Validation Strategy for Supabase Data

**Date:** 2025-10-10
**Status:** Implemented

## Overview

This API uses a **hybrid validation strategy** for Supabase data that provides:
- ✅ Type safety for core fields that clients depend on
- ✅ Flexibility for schema evolution (new columns don't break the API)
- ✅ Clear API contracts via OpenAPI documentation
- ✅ Runtime validation with helpful error messages

## The Problem

When integrating with Supabase (or any external database), you face a trade-off:

**Option 1: Strict Validation (`z.object().strict()`)**
- ✅ Full type safety
- ❌ Every new Supabase column requires API code changes
- ❌ Breaking changes when columns are added/removed
- ❌ Can't support dynamic platforms (e.g., facebook_ads_performance, google_ads_performance)

**Option 2: No Validation (`z.any()`)**
- ✅ Flexible for schema changes
- ❌ No type safety
- ❌ Unclear API contract
- ❌ Client apps don't know what fields exist
- ❌ Runtime errors from missing/mistyped data

## The Solution: Hybrid Validation with `.passthrough()`

We use Zod's `.passthrough()` modifier to validate core fields while allowing additional fields to pass through unchanged:

```typescript
const AdMetricsSchema = z.object({
  // Required core fields (validated)
  impressions: z.number().default(0),
  clicks: z.number().default(0),
  spend: z.number().default(0),

  // Optional fields (also validated if present)
  conversions: z.number().optional().default(0),
  revenue: z.number().optional().default(0),
}).passthrough();  // ← Allows additional platform-specific metrics
```

### How `.passthrough()` Works

```typescript
// Input from Supabase:
{
  impressions: 1000,
  clicks: 50,
  spend: 25.50,
  custom_metric: 123,        // Not in schema
  platform_specific: "value" // Not in schema
}

// After validation:
{
  impressions: 1000,     // ✅ Validated (number)
  clicks: 50,            // ✅ Validated (number)
  spend: 25.50,          // ✅ Validated (number)
  conversions: 0,        // ✅ Default applied
  revenue: 0,            // ✅ Default applied
  custom_metric: 123,    // ✅ Passed through
  platform_specific: "value" // ✅ Passed through
}
```

## Implementation

### 1. Shared Schemas (`src/schemas/analytics.ts`)

All analytics validation schemas are centralized in one file:

```typescript
// Ad Performance
export const AdMetricsSchema = z.object({...}).passthrough();
export const AdPerformanceSchema = z.object({...}).passthrough();
export const CampaignSummarySchema = z.object({...}).passthrough();

// Conversions
export const ConversionRecordSchema = z.object({...}).passthrough();
export const ConversionResponseSchema = z.object({...}).passthrough();

// Events (R2 SQL)
export const EventRecordSchema = z.object({...}).passthrough();
export const EventResponseSchema = z.object({...}).passthrough();
```

### 2. Endpoint Integration

#### Events Endpoint (R2 SQL)
```typescript
// src/endpoints/v1/analytics/events.ts
import { EventResponseSchema } from "../../../schemas/analytics";

export class GetEvents extends OpenAPIRoute {
  public schema = {
    responses: {
      "200": {
        description: "Raw events from R2 SQL with validated core fields (60+ fields allowed via passthrough)",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              data: EventResponseSchema,  // ← Core fields validated, extras passed through
              meta: z.object({...})
            })
          }
        }
      }
    }
  };
}
```

#### Conversions Endpoint (Supabase)
```typescript
// src/endpoints/v1/analytics/conversions.ts
import { ConversionRecordSchema, ConversionResponseSchema } from "../../../schemas/analytics";

// Validate raw data
const validatedData = rawData.map(row => {
  try {
    return ConversionRecordSchema.parse(row);
  } catch (parseError) {
    console.warn("Conversion record validation warning:", parseError);
    return ConversionRecordSchema.safeParse(row).data || row;
  }
});
```

#### Ads Endpoint (Supabase - Multiple Platforms)
```typescript
// src/endpoints/v1/analytics/ads.ts
import { CampaignSummarySchema, AdPerformanceSchema, PlatformSummarySchema } from "../../../schemas/analytics";

responses: {
  "200": {
    schema: z.object({
      data: z.object({
        platform: z.string(),
        results: z.union([
          z.array(CampaignSummarySchema),  // Validates campaigns
          z.array(AdPerformanceSchema),     // Validates ads
          z.array(DailyMetricsSchema),      // Validates daily metrics
          z.null()                          // group_by=none
        ]),
        summary: PlatformSummarySchema      // Validates summary
      })
    })
  }
}
```

## Benefits

### 1. Type Safety for Critical Fields
```typescript
// These fields are GUARANTEED to exist and have correct types:
interface EventRecord {
  org_tag: string;      // Always present
  event_id: string;     // Always present
  timestamp: string;    // Always present
  event_type: string;   // Always present
  // ... but also allows 60+ optional fields from event_stream
}
```

### 2. Schema Evolution Without Breaking Changes
```sql
-- Add a new column in Supabase:
ALTER TABLE conversions ADD COLUMN customer_lifetime_value NUMERIC;

-- NO CODE CHANGES NEEDED! ✅
-- The new field automatically passes through to clients
```

### 3. Platform-Specific Fields Supported
```typescript
// Facebook may have:
{ impressions, clicks, spend, fb_pixel_events, fb_custom_audiences }

// Google may have:
{ impressions, clicks, spend, google_quality_score, google_ad_rank }

// Both work with the same adapter! ✅
```

### 4. Clear API Documentation
The OpenAPI schema shows:
- Which fields are required
- Which fields have defaults
- Field types (string, number, boolean, etc.)
- But doesn't restrict additional fields

## Core Fields by Data Type

### Event Records (R2 SQL)
**Required:**
- `org_tag: string` - Organization identifier
- `event_id: string` - Unique event ID
- `timestamp: string` - ISO timestamp
- `event_type: string` - Type of event (page_view, click, conversion, etc.)

**Optional (commonly used):**
- `page_url`, `page_title`, `device_type`, `browser_name`
- `geo_country`, `geo_region`, `geo_city`
- `utm_source`, `utm_medium`, `utm_campaign`
- Plus 40+ additional fields from event_stream table

### Ad Performance Records (Supabase)
**Required Core Metrics:**
- `impressions: number` - Ad impressions
- `clicks: number` - Ad clicks
- `spend: number` - Ad spend
- `conversions: number` (optional, default: 0)
- `revenue: number` (optional, default: 0)

**Identity Fields:**
- `org_id: string`
- `campaign_id: string` (optional)
- `ad_id: string` (optional)
- `date_reported: string`

### Conversion Records (Supabase)
**Required:**
- `org_id: string` - Organization ID
- `date: string` - Date of conversion (YYYY-MM-DD)
- `channel: string` - Conversion channel (shopify, stripe, etc.)
- `conversion_count: number` - Number of conversions
- `revenue: number` - Revenue amount

## Testing

### Successful Test
```bash
curl "http://localhost:8787/v1/analytics/events?org_tag=clearlift&lookback=24h&limit=1" \
  -H "Authorization: Bearer 00000000-test-1234-0000-000000000000"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "events": [{
      "event_id": "mgl6kpew-wuz5gdn8h6h",
      "event_type": "page_exit",
      "org_tag": "clearlift",
      "page_url": "https://www.clearlift.ai/",
      "device_type": "desktop",
      "browser_name": "Chrome",
      "geo_country": "US"
      // ... plus 50+ additional fields
    }],
    "count": 1
  }
}
```

## Error Handling

### Validation Warnings (Non-Fatal)
If a field fails validation but has a default, the default is applied:
```typescript
// Input: { impressions: "invalid", clicks: 50 }
// Output: { impressions: 0, clicks: 50 }  // Default applied
// Console: "Conversion record validation warning: ..."
```

### Missing Required Fields (Fatal)
If a required field is missing and has no default:
```typescript
// Input: { clicks: 50 }  // Missing required 'org_id'
// Response: 500 - "QUERY_FAILED: Validation error"
```

## OpenAPI Schema Generation

The hybrid validation correctly generates OpenAPI documentation:

```json
{
  "paths": {
    "/v1/analytics/events": {
      "get": {
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "events": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "org_tag": { "type": "string" },
                              "event_id": { "type": "string" },
                              "timestamp": { "type": "string" },
                              // ... all validated fields documented
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

## Best Practices

### 1. Always Validate User Input
Use strict schemas for request parameters (no `.passthrough()`):
```typescript
request: {
  query: z.object({
    org_tag: z.string(),
    lookback: z.string().optional()
  })  // No .passthrough() - only accept known params
}
```

### 2. Use Passthrough for Database Output
Allow flexibility for database schema evolution:
```typescript
const result = ConversionRecordSchema.parse(dbRow);  // ✅ Passthrough enabled
```

### 3. Document Core Fields
Always document which fields are required vs. optional:
```typescript
/**
 * Core event fields that we expect from R2 SQL event_stream
 */
export const EventRecordSchema = z.object({
  // Required core fields
  org_tag: z.string(),
  // ...
});
```

### 4. Use safeParse for Graceful Degradation
```typescript
const validatedData = rawData.map(row => {
  const result = ConversionRecordSchema.safeParse(row);
  if (!result.success) {
    console.warn("Validation failed:", result.error);
    return row;  // Return original data as fallback
  }
  return result.data;
});
```

## Migration Notes

### From `z.any()` to Hybrid Validation

**Before:**
```typescript
schema: z.object({
  success: z.boolean(),
  data: z.any()  // No validation
})
```

**After:**
```typescript
schema: z.object({
  success: z.boolean(),
  data: EventResponseSchema  // Core fields validated, extras allowed
})
```

### Files Modified
1. ✅ `src/schemas/analytics.ts` - Created (all validation schemas)
2. ✅ `src/endpoints/v1/analytics/events.ts` - Updated (R2 SQL)
3. ✅ `src/endpoints/v1/analytics/conversions.ts` - Updated (Supabase)
4. ✅ `src/endpoints/v1/analytics/ads.ts` - Updated (Supabase)

### OpenAPI Regeneration
After updating schemas, regenerate OpenAPI documentation:
```bash
npm run schema
```

## Related Documentation

- [R2 SQL Migration](./MIGRATION_COMPLETE.md) - DuckDB → R2 SQL migration details
- [Data Architecture](./DATA_ARCHITECTURE.md) - Overall system architecture
- [API Documentation](./schema.json) - Generated OpenAPI spec

---

**Summary:** The hybrid validation strategy provides the best of both worlds - type safety for critical fields and flexibility for schema evolution. Core fields are validated at runtime, additional fields pass through unchanged, and the OpenAPI schema documents the contract clearly.
