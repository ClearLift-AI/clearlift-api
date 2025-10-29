# Stripe Migration Guide: Charges → Payment Intents

## Overview

We've upgraded the Stripe connector to use **payment_intents** as the primary tracking unit instead of charges. This provides better conversion tracking and removes personally identifiable information (PII) from stored data.

## What Changed

### 1. Tracking Unit: Payment Intents Only
- **Before**: Tracked charges, invoices, or line items (user-configurable)
- **After**: Always tracks `payment_intents` with `status='succeeded'`
- **Why**: Payment intents are the recommended Stripe object for conversion tracking. They represent a customer's intent to pay and persist through the entire payment flow.

### 2. PII Removed
- **Before**: Stored customer email addresses in plaintext
- **After**: Stores SHA256 hash of email for anonymous analytics
- **Why**: Improved privacy and security compliance

### 3. Invoice Line Items Support
- **Before**: Line items required separate tracking mode
- **After**: Line items automatically included when payment_intent has an invoice
- **Why**: Simpler configuration, richer data

### 4. Status Filtering
- **Before**: Tracked all payment statuses (succeeded, pending, failed)
- **After**: Only tracks `succeeded` payments
- **Why**: Focus on actual conversions, reduce noise

## Migration Steps

### Step 1: Understand the Impact

**Data Loss**: All existing Stripe conversion data (charges) will be deleted during migration. This is a clean-slate approach chosen to ensure data consistency.

**Reconfiguration Required**: All existing Stripe connections will be marked for reconfiguration and will stop syncing until reconnected.

### Step 2: Export Existing Data (Optional)

If you need historical charge data, export it before the migration:

```sql
-- Run in Supabase SQL Editor
COPY (
  SELECT * FROM clearlift.stripe_conversions
  WHERE stripe_type = 'charge'
) TO '/tmp/stripe_charges_backup.csv' WITH CSV HEADER;
```

### Step 3: Wait for Migration Deployment

The Clearlift team will:
1. Run Supabase schema migration (adds new columns)
2. Deploy updated cron worker (payment_intent tracking)
3. Deploy updated API (reconfiguration enforcement)
4. Delete all existing charge data

### Step 4: Reconnect Your Stripe Account

After migration, you'll see a notice when accessing your Stripe connection. To reconnect:

1. Go to **Settings → Integrations → Stripe**
2. Click **Reconnect** on your existing connection
3. Provide your Stripe API key again
4. Configure lookback period (default: 30 days)
5. Save

Your connection will immediately begin syncing succeeded payment_intents from the lookback period.

## New Features

### Line Items Metadata

Payment intents with invoices now automatically include line item details:

```json
{
  "payment_intent_id": "pi_xxx",
  "amount": 10000,
  "has_invoice": true,
  "metadata": {
    "line_items": [
      {
        "id": "li_xxx",
        "price": {
          "id": "price_xxx",
          "product": "prod_xxx",
          "unit_amount": 5000,
          "currency": "usd"
        },
        "quantity": 2,
        "amount": 10000,
        "description": "Pro Plan Subscription",
        "currency": "usd"
      }
    ]
  }
}
```

### Anonymous Customer Analytics

Customer emails are now hashed:

```json
{
  "customer_id": "cus_xxx",
  "customer_email": null,
  "customer_email_hash": "5d41402abc4b2a76b9719d911017c592"
}
```

You can still:
- Count unique customers (using hash)
- Track repeat customers (using hash)
- Segment by customer (using hash)

You **cannot**:
- See actual email addresses
- Email customers directly from Clearlift

## API Changes

### Removed Fields
- `sync_mode` config option (always payment_intents)
- `customer_email` from response (use `customer_email_hash`)

### New Fields
- `payment_intent_id` - Primary identifier
- `customer_email_hash` - SHA256 hash
- `has_invoice` - Boolean flag
- `metadata.line_items` - Array of line item objects

### Example Query

```javascript
// Before (charges)
const charges = await supabase
  .from('stripe_conversions')
  .select('*')
  .eq('stripe_type', 'charge')
  .gte('conversion_value', 5000);

// After (payment_intents)
const payments = await supabase
  .from('stripe_conversions')
  .select('*')
  .eq('stripe_type', 'payment_intent')
  .gte('conversion_value', 5000)
  .eq('payment_status', 'succeeded'); // Always succeeded post-migration
```

### Filtering by Line Items

```javascript
// Find payments with specific product in line items
const payments = await supabase
  .from('stripe_conversions')
  .select('*')
  .contains('metadata', {
    line_items: [{ price: { product: 'prod_abc123' } }]
  });
```

## FAQ

### Q: Why delete existing data instead of migrating it?

**A**: Charges and payment_intents have different data structures and semantics. A 1:1 migration would be misleading. The clean-slate approach ensures data integrity and allows us to leverage payment_intent-specific features like expanded invoice data.

### Q: What if I need historical charge data?

**A**: Export your data before migration using the SQL query above, or contact support for a data dump.

### Q: Will my analytics dashboards break?

**A**: If you're querying `stripe_type='charge'`, you'll need to update to `stripe_type='payment_intent'`. Field names remain mostly the same.

### Q: What about refunds?

**A**: Refunds are not tracked as separate conversions. Check `payment_intent.charges.data[0].refunds` in the `raw_data` field.

### Q: Can I still track test mode payments?

**A**: Yes! Test mode payment_intents (using `sk_test_` keys) are tracked separately from live mode.

### Q: How do line items affect my conversion value?

**A**: The `conversion_value` is still the payment_intent `amount`. Line items are metadata for filtering and analysis, not separate conversions.

## Troubleshooting

### "REQUIRES_RECONFIGURATION" Error

**Cause**: Your Stripe connection was created before the migration.

**Solution**: Reconnect your Stripe account (see Step 4 above).

### No Data After Reconnecting

**Possible causes**:
1. **No succeeded payments in lookback period**: Check your Stripe dashboard
2. **API key restrictions**: Ensure key has read access to payment_intents
3. **Sync job failed**: Check sync logs in Settings → Integrations → Stripe → View Logs

### Line Items Not Appearing

**Cause**: Payment intents without invoices don't have line items.

**Solution**: Only subscription-based or multi-item payments have invoices. One-time payments via Checkout/Payment Links may not have line items.

## Support

Questions? Contact support at support@clearlift.ai or open an issue on GitHub.

---

**Migration Date**: October 27, 2025
**Cron Version**: 2.0.0
**API Version**: 2.0.0
