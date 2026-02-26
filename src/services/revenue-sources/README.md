# Revenue Source Plugin System

A modular system for aggregating conversion and revenue data from multiple connected platforms (Stripe, Shopify, Jobber, etc.) for Real-Time analytics.

## Architecture

```
revenue-sources/
├── index.ts      # Core interfaces, registry, and getCombinedRevenue helper
├── providers.ts  # Imports all providers to trigger self-registration
├── stripe.ts     # Stripe charges provider
├── shopify.ts    # Shopify orders provider
├── jobber.ts     # Jobber invoices provider
└── README.md     # This file
```

## How It Works

1. Each revenue source implements the `RevenueSourceProvider` interface
2. Providers self-register with `revenueSourceRegistry` when imported
3. The `getCombinedRevenue()` helper queries all available providers
4. Results are aggregated and returned with per-source breakdown

## Core Interface

```typescript
interface RevenueSourceProvider {
  meta: {
    platform: string;        // 'stripe', 'shopify', 'jobber'
    displayName: string;     // 'Stripe Payments'
    conversionLabel: string; // 'Charges', 'Orders', 'Invoices'
  };

  // Check if this org has data from this source
  hasData(db: D1Database, orgId: string): Promise<boolean>;

  // Get summary metrics for last N hours
  getSummary(db: D1Database, orgId: string, hours: number): Promise<{
    conversions: number;
    revenue: number;
    uniqueCustomers: number;
  }>;

  // Get hourly time series for charts
  getTimeSeries(db: D1Database, orgId: string, hours: number): Promise<{
    bucket: string;
    conversions: number;
    revenue: number;
  }[]>;
}
```

## Adding a New Revenue Source

### 1. Create the Provider File

Create `src/services/revenue-sources/square.ts`:

```typescript
import {
  RevenueSourceProvider,
  RevenueSourceMeta,
  RevenueSourceSummary,
  RevenueSourceTimeSeries,
  revenueSourceRegistry,
} from './index';

const meta: RevenueSourceMeta = {
  platform: 'square',
  displayName: 'Square Payments',
  conversionLabel: 'Transactions',
};

const squareProvider: RevenueSourceProvider = {
  meta,

  async hasData(db, orgId) {
    // All connectors use the unified connector_events table
    const result = await db.prepare(`
      SELECT 1 FROM connector_events
      WHERE organization_id = ? AND source_platform = 'square' LIMIT 1
    `).bind(orgId).first();
    return !!result;
  },

  async getSummary(db, orgId, hours) {
    const result = await db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('succeeded', 'paid', 'completed') THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN status IN ('succeeded', 'paid', 'completed') THEN value_cents ELSE 0 END) as revenue_cents,
        COUNT(DISTINCT customer_external_id) as unique_customers
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'square'
        AND transacted_at >= datetime('now', '-' || ? || ' hours')
    `).bind(orgId, hours).first();

    return {
      conversions: result?.conversions || 0,
      revenue: (result?.revenue_cents || 0) / 100,
      uniqueCustomers: result?.unique_customers || 0,
    };
  },

  async getTimeSeries(db, orgId, hours) {
    const result = await db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', transacted_at) as bucket,
        SUM(CASE WHEN status IN ('succeeded', 'paid', 'completed') THEN 1 ELSE 0 END) as conversions,
        SUM(CASE WHEN status IN ('succeeded', 'paid', 'completed') THEN value_cents ELSE 0 END) as revenue_cents
      FROM connector_events
      WHERE organization_id = ?
        AND source_platform = 'square'
        AND transacted_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY bucket
      ORDER BY bucket ASC
    `).bind(orgId, hours).all();

    return result.results.map(row => ({
      bucket: row.bucket,
      conversions: row.conversions,
      revenue: row.revenue_cents / 100,
    }));
  },
};

// Self-register
revenueSourceRegistry.register(squareProvider);

export default squareProvider;
```

### 2. Register the Provider

Add import to `providers.ts`:

```typescript
import './stripe';
import './shopify';
import './jobber';
import './square';  // Add this line
```

That's it! The new source will automatically:
- Be discovered for orgs that have Square data
- Be included in combined revenue calculations
- Appear in the `availableSources` array in API responses
- Respect the `disabled_conversion_sources` setting

## Usage

### In API Endpoints

```typescript
import { getCombinedRevenue } from '../services/revenue-sources/providers';

// Get combined revenue from all sources
const result = await getCombinedRevenue(
  analyticsDb,
  orgId,
  hours,
  disabledSources  // e.g., ['jobber'] to exclude Jobber
);

// result.summary.conversions - total conversions
// result.summary.revenue - total revenue
// result.summary.sources - per-source breakdown
// result.timeSeries - combined hourly data
// result.availableSources - metadata for available sources
```

### API Response Format

```json
{
  "summary": {
    "conversions": 150,
    "revenue": 25000.00,
    "uniqueCustomers": 120,
    "sources": {
      "stripe": {
        "conversions": 80,
        "revenue": 15000.00,
        "displayName": "Stripe Payments"
      },
      "shopify": {
        "conversions": 50,
        "revenue": 8000.00,
        "displayName": "Shopify Orders"
      },
      "jobber": {
        "conversions": 20,
        "revenue": 2000.00,
        "displayName": "Jobber Invoices"
      }
    }
  },
  "timeSeries": [
    { "bucket": "2025-01-20 10:00:00", "conversions": 5, "revenue": 1200.00 },
    { "bucket": "2025-01-20 11:00:00", "conversions": 8, "revenue": 1800.00 }
  ],
  "availableSources": [
    { "platform": "stripe", "displayName": "Stripe Payments", "conversionLabel": "Charges" },
    { "platform": "shopify", "displayName": "Shopify Orders", "conversionLabel": "Orders" },
    { "platform": "jobber", "displayName": "Jobber Invoices", "conversionLabel": "Paid Invoices" }
  ]
}
```

## Conversion Definitions by Source

| Source | Table | Conversion Criteria | Revenue Field |
|--------|-------|---------------------|---------------|
| Stripe | `connector_events WHERE source_platform='stripe'` | `status IN ('succeeded','paid')` | `value_cents` |
| Shopify | `connector_events WHERE source_platform='shopify'` | `status IN ('paid','fulfilled')` | `value_cents` |
| Jobber | `connector_events WHERE source_platform='jobber'` | `status IN ('completed','paid')` | `value_cents` |

## Settings Integration

The system respects the `disabled_conversion_sources` setting from `ai_optimization_settings`:

```sql
-- Example: Disable Jobber from revenue calculations
UPDATE ai_optimization_settings
SET disabled_conversion_sources = '["jobber"]'
WHERE org_id = 'xxx';
```

Users can toggle sources on/off in Settings → AI & Automation → Conversion Sources.

## Error Handling

- If a provider's table doesn't exist, it's silently skipped
- If a provider query fails, other providers still return data
- Errors are logged but don't break the overall response

## Future Extensions

To add support for new platforms:

1. Add the connector config seed to `migrations-adbliss-analytics` (events_schema JSON)
2. Implement the sync workflow in clearlift-cron (writes to `connector_events`)
3. Create the revenue source provider (as shown above — queries `connector_events WHERE source_platform = '...'`)
4. Add the import to `providers.ts`

All connectors use the unified `connector_events` table — no per-platform tables needed.
The dashboard will automatically show the new source in Real-Time analytics.
