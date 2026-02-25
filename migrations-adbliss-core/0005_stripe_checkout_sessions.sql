-- Migration: Add checkout_session event type to Stripe connector config
-- Checkout Sessions unify one-time payments and subscriptions via Stripe Checkout.
-- success_url/cancel_url enable journey graph auto-population.
--
-- Backward compatible: existing 'charge' event type kept as "(Legacy)" for merchants
-- who don't use Stripe Checkout. Old connector_events rows with event_type='charge'
-- or 'subscription' remain valid.

UPDATE connector_configs
SET events_schema = json('[
  {"id":"checkout_session","name":"Checkout Session","description":"Completed checkout (one-time payments and subscriptions via Stripe Checkout)","fields":["amount","currency","customer_email","mode","success_url"],"statuses":["succeeded","pending"],"default_status":["succeeded"]},
  {"id":"charge","name":"Direct Payment (Legacy)","description":"API-created charges not using Checkout (for merchants with custom integrations)","fields":["amount","currency","customer_email","billing_reason"],"statuses":["succeeded","pending","failed"],"default_status":["succeeded"]}
]'),
    description = 'Track payments, subscriptions, and revenue from Stripe Checkout',
    permissions_description = 'Read access to checkout sessions, charges, and customers'
WHERE provider = 'stripe';
