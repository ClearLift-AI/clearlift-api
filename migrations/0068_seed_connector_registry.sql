-- Migration number: 0068 2026-01-25T00:00:00.000Z
-- Seed connector_configs with full registry metadata for all supported connectors
-- This populates the extended fields from migration 0067

-- =====================================================================
-- AD PLATFORMS
-- =====================================================================

-- Google Ads
UPDATE connector_configs SET
  connector_type = 'ad_platform',
  category = 'advertising',
  description = 'Import Google Ads campaigns, ad groups, and performance metrics',
  documentation_url = 'https://docs.clearlift.ai/connectors/google-ads',
  icon_name = 'SiGoogle',
  icon_color = '#4285F4',
  sort_order = 10,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = FALSE,
  is_beta = FALSE,
  events_schema = json('[
    {"id": "ad_click", "name": "Ad Click", "fields": ["campaign_id", "ad_group_id", "gclid"]},
    {"id": "conversion", "name": "Conversion", "fields": ["conversion_action", "value", "currency"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 1000,
  default_lookback_days = 90,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-blue-50',
  theme_border_color = 'border-blue-200',
  theme_text_color = 'text-blue-700',
  has_actual_value = TRUE,
  value_field = 'value',
  permissions_description = 'Read access to Google Ads account data including campaigns, ad groups, and performance metrics',
  platform_id = 'google'
WHERE provider = 'google';

-- Facebook/Meta Ads
UPDATE connector_configs SET
  connector_type = 'ad_platform',
  category = 'advertising',
  description = 'Import Meta Ads campaigns, ad sets, and performance data',
  documentation_url = 'https://docs.clearlift.ai/connectors/meta-ads',
  icon_name = 'SiFacebook',
  icon_color = '#1877F2',
  sort_order = 20,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = FALSE,
  is_beta = FALSE,
  events_schema = json('[
    {"id": "ad_click", "name": "Ad Click", "fields": ["campaign_id", "ad_id", "fbclid"]},
    {"id": "lead", "name": "Lead", "fields": ["campaign_id", "lead_id"]},
    {"id": "purchase", "name": "Purchase", "fields": ["campaign_id", "value", "currency"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 500,
  default_lookback_days = 90,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-blue-50',
  theme_border_color = 'border-blue-300',
  theme_text_color = 'text-blue-800',
  has_actual_value = TRUE,
  value_field = 'value',
  permissions_description = 'Read access to Facebook Ads data and Business Management',
  platform_id = 'facebook'
WHERE provider = 'facebook';

-- TikTok Ads
UPDATE connector_configs SET
  connector_type = 'ad_platform',
  category = 'advertising',
  description = 'Import TikTok Ads campaigns and performance metrics',
  documentation_url = 'https://docs.clearlift.ai/connectors/tiktok-ads',
  icon_name = 'SiTiktok',
  icon_color = '#000000',
  sort_order = 30,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = FALSE,
  is_beta = FALSE,
  events_schema = json('[
    {"id": "ad_click", "name": "Ad Click", "fields": ["campaign_id", "ad_id", "ttclid"]},
    {"id": "conversion", "name": "Conversion", "fields": ["event_type", "value", "currency"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 600,
  default_lookback_days = 90,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-gray-50',
  theme_border_color = 'border-gray-300',
  theme_text_color = 'text-gray-900',
  has_actual_value = TRUE,
  value_field = 'value',
  permissions_description = 'Read access to TikTok Ads data',
  platform_id = 'tiktok'
WHERE provider = 'tiktok';

-- =====================================================================
-- REVENUE PLATFORMS
-- =====================================================================

-- Stripe
UPDATE connector_configs SET
  connector_type = 'revenue',
  category = 'payments',
  description = 'Track payments, subscriptions, and revenue from Stripe',
  documentation_url = 'https://docs.clearlift.ai/connectors/stripe',
  icon_name = 'SiStripe',
  icon_color = '#635BFF',
  sort_order = 40,
  supports_sync = TRUE,
  supports_realtime = TRUE,
  supports_webhooks = TRUE,
  is_beta = FALSE,
  events_schema = json('[
    {"id": "payment_success", "name": "Payment Success", "fields": ["amount", "currency", "customer_email"]},
    {"id": "trial_started", "name": "Trial Started", "fields": ["plan", "trial_days"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["amount", "interval", "plan"]},
    {"id": "subscription_cancelled", "name": "Subscription Cancelled", "fields": ["reason", "plan"]},
    {"id": "refund_created", "name": "Refund Created", "fields": ["amount", "reason"]}
  ]'),
  default_concurrency = 3,
  rate_limit_per_hour = 1000,
  default_lookback_days = 90,
  default_sync_interval_hours = 4,
  theme_bg_color = 'bg-purple-50',
  theme_border_color = 'border-purple-200',
  theme_text_color = 'text-purple-700',
  has_actual_value = TRUE,
  value_field = 'conversion_value',
  permissions_description = 'Read access to charges, customers, and subscriptions',
  platform_id = 'stripe'
WHERE provider = 'stripe';

-- Shopify
UPDATE connector_configs SET
  connector_type = 'revenue',
  category = 'ecommerce',
  description = 'Import orders, customers, and sales data from Shopify',
  documentation_url = 'https://docs.clearlift.ai/connectors/shopify',
  icon_name = 'SiShopify',
  icon_color = '#7AB55C',
  sort_order = 50,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = TRUE,
  is_beta = FALSE,
  events_schema = json('[
    {"id": "product_viewed", "name": "Product Viewed", "fields": ["product_id", "product_type"]},
    {"id": "cart_updated", "name": "Add to Cart", "fields": ["cart_total", "item_count"]},
    {"id": "checkout_started", "name": "Checkout Started", "fields": ["checkout_total"]},
    {"id": "order_placed", "name": "Order Placed", "fields": ["order_total", "discount_code"]},
    {"id": "order_fulfilled", "name": "Order Fulfilled", "fields": ["order_total"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 400,
  default_lookback_days = 60,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-green-50',
  theme_border_color = 'border-green-200',
  theme_text_color = 'text-green-700',
  has_actual_value = TRUE,
  value_field = 'total_price_cents',
  permissions_description = 'Read access to orders and customers',
  platform_id = 'shopify'
WHERE provider = 'shopify';

-- Jobber
UPDATE connector_configs SET
  connector_type = 'revenue',
  category = 'field_service',
  description = 'Track jobs, invoices, and revenue from Jobber',
  documentation_url = 'https://docs.clearlift.ai/connectors/jobber',
  icon_name = 'Wrench',
  icon_color = '#00B2A9',
  sort_order = 60,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = FALSE,
  is_beta = TRUE,
  events_schema = json('[
    {"id": "quote_sent", "name": "Quote Sent", "fields": ["quote_total", "service_type"]},
    {"id": "quote_approved", "name": "Quote Approved", "fields": ["quote_total", "customer_id"]},
    {"id": "job_scheduled", "name": "Job Scheduled", "fields": ["job_total", "scheduled_date"]},
    {"id": "job_completed", "name": "Job Completed", "fields": ["job_total", "completed_date"]},
    {"id": "invoice_paid", "name": "Invoice Paid", "fields": ["invoice_total", "payment_method"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 300,
  default_lookback_days = 90,
  default_sync_interval_hours = 12,
  theme_bg_color = 'bg-teal-50',
  theme_border_color = 'border-teal-200',
  theme_text_color = 'text-teal-700',
  has_actual_value = TRUE,
  value_field = 'total_cents',
  permissions_description = 'Read access to jobs, invoices, clients, quotes, and requests',
  platform_id = 'jobber'
WHERE provider = 'jobber';

-- =====================================================================
-- FUTURE PAYMENT CONNECTORS (from migration 0066)
-- =====================================================================

-- Lemon Squeezy
UPDATE connector_configs SET
  connector_type = 'revenue',
  category = 'payments',
  description = 'Track orders and subscriptions from Lemon Squeezy',
  documentation_url = 'https://docs.clearlift.ai/connectors/lemon-squeezy',
  icon_name = 'Citrus',
  icon_color = '#FFC233',
  sort_order = 70,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = TRUE,
  is_beta = TRUE,
  events_schema = json('[
    {"id": "order_completed", "name": "Order Completed", "fields": ["total", "currency", "customer_email"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["variant_id", "total"]},
    {"id": "refund_created", "name": "Refund Created", "fields": ["amount", "reason"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 500,
  default_lookback_days = 90,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-yellow-50',
  theme_border_color = 'border-yellow-200',
  theme_text_color = 'text-yellow-700',
  has_actual_value = TRUE,
  value_field = 'total_cents',
  permissions_description = 'Read access to orders and subscriptions',
  platform_id = 'lemon_squeezy'
WHERE provider = 'lemon_squeezy';

-- Paddle
UPDATE connector_configs SET
  connector_type = 'revenue',
  category = 'payments',
  description = 'Track transactions and subscriptions from Paddle',
  documentation_url = 'https://docs.clearlift.ai/connectors/paddle',
  icon_name = 'Waves',
  icon_color = '#3B6BE7',
  sort_order = 80,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = TRUE,
  is_beta = TRUE,
  events_schema = json('[
    {"id": "transaction_completed", "name": "Transaction Completed", "fields": ["total", "currency", "customer_id"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["billing_period", "price_id"]},
    {"id": "subscription_cancelled", "name": "Subscription Cancelled", "fields": ["reason"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 500,
  default_lookback_days = 90,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-blue-50',
  theme_border_color = 'border-blue-200',
  theme_text_color = 'text-blue-700',
  has_actual_value = TRUE,
  value_field = 'total_cents',
  permissions_description = 'Read access to transactions and subscriptions',
  platform_id = 'paddle'
WHERE provider = 'paddle';

-- Chargebee
UPDATE connector_configs SET
  connector_type = 'revenue',
  category = 'payments',
  description = 'Track invoices and subscriptions from Chargebee',
  documentation_url = 'https://docs.clearlift.ai/connectors/chargebee',
  icon_name = 'CreditCard',
  icon_color = '#FF6600',
  sort_order = 90,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = TRUE,
  is_beta = TRUE,
  events_schema = json('[
    {"id": "invoice_paid", "name": "Invoice Paid", "fields": ["total", "currency", "customer_id"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["plan_id", "billing_period"]},
    {"id": "payment_failed", "name": "Payment Failed", "fields": ["amount", "reason"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 500,
  default_lookback_days = 90,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-orange-50',
  theme_border_color = 'border-orange-200',
  theme_text_color = 'text-orange-700',
  has_actual_value = TRUE,
  value_field = 'total_cents',
  permissions_description = 'Read access to invoices and subscriptions',
  platform_id = 'chargebee'
WHERE provider = 'chargebee';

-- Recurly
UPDATE connector_configs SET
  connector_type = 'revenue',
  category = 'payments',
  description = 'Track invoices and subscriptions from Recurly',
  documentation_url = 'https://docs.clearlift.ai/connectors/recurly',
  icon_name = 'Repeat',
  icon_color = '#24272B',
  sort_order = 100,
  supports_sync = TRUE,
  supports_realtime = FALSE,
  supports_webhooks = TRUE,
  is_beta = TRUE,
  events_schema = json('[
    {"id": "invoice_paid", "name": "Invoice Paid", "fields": ["total", "currency", "account_email"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["plan_code", "unit_amount"]},
    {"id": "charge_invoice", "name": "Charge Invoice", "fields": ["total", "subtotal"]}
  ]'),
  default_concurrency = 2,
  rate_limit_per_hour = 500,
  default_lookback_days = 90,
  default_sync_interval_hours = 6,
  theme_bg_color = 'bg-gray-50',
  theme_border_color = 'border-gray-200',
  theme_text_color = 'text-gray-700',
  has_actual_value = TRUE,
  value_field = 'total_cents',
  permissions_description = 'Read access to invoices and subscriptions',
  platform_id = 'recurly'
WHERE provider = 'recurly';

-- =====================================================================
-- INTERNAL/EVENT CONNECTORS (insert new records)
-- =====================================================================

-- ClearLift Tag (internal events connector)
INSERT OR REPLACE INTO connector_configs (
  id,
  provider,
  name,
  auth_type,
  is_active,
  connector_type,
  category,
  description,
  icon_name,
  icon_color,
  sort_order,
  supports_sync,
  supports_realtime,
  supports_webhooks,
  is_beta,
  events_schema,
  theme_bg_color,
  theme_border_color,
  theme_text_color,
  has_actual_value,
  permissions_description,
  platform_id
) VALUES (
  'clearlift_tag-001',
  'clearlift_tag',
  'ClearLift Tag',
  'internal',
  TRUE,
  'events',
  'analytics',
  'Track page views, clicks, and custom events with the ClearLift JavaScript tag',
  'Zap',
  '#6366F1',
  5,
  FALSE,
  TRUE,
  FALSE,
  FALSE,
  json('[
    {"id": "page_view", "name": "Page View", "fields": ["page_path", "page_title", "referrer"]},
    {"id": "click", "name": "Click", "fields": ["element_id", "element_class", "element_text", "href"]},
    {"id": "form_submit", "name": "Form Submit", "fields": ["form_id", "form_name"]},
    {"id": "scroll", "name": "Scroll Depth", "fields": ["scroll_depth"]},
    {"id": "goal_completed", "name": "Goal Completed", "fields": ["goal_name", "goal_value"]},
    {"id": "custom", "name": "Custom Event", "fields": ["event_type", "event_data"]}
  ]'),
  'bg-indigo-50',
  'border-indigo-200',
  'text-indigo-700',
  FALSE,
  'No external permissions required - events tracked via JavaScript tag',
  'clearlift_tag'
);

-- Tracking Links (internal)
INSERT OR REPLACE INTO connector_configs (
  id,
  provider,
  name,
  auth_type,
  is_active,
  connector_type,
  category,
  description,
  icon_name,
  icon_color,
  sort_order,
  supports_sync,
  supports_realtime,
  supports_webhooks,
  is_beta,
  events_schema,
  theme_bg_color,
  theme_border_color,
  theme_text_color,
  has_actual_value,
  permissions_description,
  platform_id
) VALUES (
  'tracking_link-001',
  'tracking_link',
  'Tracking Link',
  'internal',
  TRUE,
  'events',
  'analytics',
  'Track clicks and conversions from custom tracking links',
  'Link2',
  '#8B5CF6',
  6,
  FALSE,
  TRUE,
  FALSE,
  FALSE,
  json('[
    {"id": "link_click", "name": "Link Click", "fields": ["link_id", "utm_source", "utm_medium", "utm_campaign"]},
    {"id": "link_conversion", "name": "Link Conversion", "fields": ["link_id", "conversion_value"]}
  ]'),
  'bg-violet-50',
  'border-violet-200',
  'text-violet-700',
  FALSE,
  'No external permissions required - links managed in ClearLift',
  'tracking_link'
);

-- =====================================================================
-- FUTURE CONNECTORS (insert new records)
-- =====================================================================

-- Attentive (SMS marketing)
INSERT OR REPLACE INTO connector_configs (
  id,
  provider,
  name,
  auth_type,
  is_active,
  connector_type,
  category,
  description,
  icon_name,
  icon_color,
  sort_order,
  supports_sync,
  supports_realtime,
  supports_webhooks,
  is_beta,
  events_schema,
  theme_bg_color,
  theme_border_color,
  theme_text_color,
  has_actual_value,
  value_field,
  permissions_description,
  platform_id
) VALUES (
  'attentive-001',
  'attentive',
  'Attentive',
  'api_key',
  FALSE,
  'sms',
  'communication',
  'Track SMS campaign clicks and conversions from Attentive',
  'MessageSquare',
  '#1A1A2E',
  110,
  TRUE,
  FALSE,
  TRUE,
  TRUE,
  json('[
    {"id": "sms_click", "name": "SMS Click", "fields": ["campaign_id", "subscriber_id"]},
    {"id": "sms_conversion", "name": "SMS Conversion", "fields": ["campaign_id", "revenue"]}
  ]'),
  'bg-slate-50',
  'border-slate-200',
  'text-slate-700',
  TRUE,
  'revenue',
  'Read access to campaign and subscriber data',
  'attentive'
);
