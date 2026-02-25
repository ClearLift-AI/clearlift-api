-- Seed connector_configs with correct event IDs matching sync writer output.
-- Event IDs MUST match connector_events.event_type values written by sync workflows.
-- All status values are lowercase (normalized at ingestion in Phase 0).
-- events_schema includes statuses[] and default_status[] for ConversionEventPicker.

-- AdBliss Tag (internal)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'adbliss_tag-001', 'adbliss_tag', 'AdBliss Tag', 'internal', TRUE, 'events', 'analytics',
  'Track page views, clicks, and custom events with the AdBliss JavaScript tag',
  'Zap', '#6366F1', 5,
  FALSE, TRUE, FALSE, FALSE,
  json('[
    {"id":"page_view","name":"Page View","fields":["page_path","page_title","referrer"]},
    {"id":"click","name":"Click","fields":["element_id","element_class","element_text","href"]},
    {"id":"form_submit","name":"Form Submit","fields":["form_id","form_name"]},
    {"id":"scroll","name":"Scroll Depth","fields":["scroll_depth"]},
    {"id":"custom","name":"Custom Event","fields":["event_type","event_data"]}
  ]'),
  'bg-indigo-50', 'border-indigo-200', 'text-indigo-700',
  FALSE, NULL,
  'No external permissions required - events tracked via JavaScript tag',
  'adbliss_tag'
);

-- Tracking Link (internal)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'tracking_link-001', 'tracking_link', 'Tracking Link', 'internal', TRUE, 'events', 'analytics',
  'Track clicks and conversions from custom tracking links',
  'Link', '#8B5CF6', 6,
  FALSE, TRUE, FALSE, FALSE,
  json('[
    {"id":"link_click","name":"Link Click","description":"Email/SMS tracking link clicked","fields":["link_id","destination_url","utm_source","utm_campaign"],"statuses":["clicked"],"default_status":["clicked"]}
  ]'),
  'bg-violet-50', 'border-violet-200', 'text-violet-700',
  FALSE, NULL,
  'No external permissions required',
  'tracking_link'
);

-- Stripe (payments)
-- Sync writer: charge (succeeded/pending/failed), subscription (active/trialing/past_due/canceled/incomplete)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'stripe-001', 'stripe', 'Stripe', 'api_key', TRUE, 'payments', 'commerce',
  'Track payments, subscriptions, and revenue from Stripe',
  'SiStripe', '#635BFF', 40,
  TRUE, TRUE, TRUE, FALSE,
  json('[
    {"id":"charge","name":"Payment","description":"Successful charges (one-time and recurring)","fields":["amount","currency","customer_email","billing_reason"],"statuses":["succeeded","pending","failed"],"default_status":["succeeded"]},
    {"id":"subscription","name":"New Subscription","description":"New subscriber created (counts once at creation, regardless of later status changes)","fields":["amount","currency","customer_email","plan_interval"],"statuses":["created"],"default_status":["created"]}
  ]'),
  'bg-purple-50', 'border-purple-200', 'text-purple-700',
  TRUE, 'conversion_value',
  'Read access to charges, customers, and subscriptions',
  'stripe'
);

-- Shopify (ecommerce)
-- Sync writer: order (paid/partially_paid/partially_refunded/refunded/voided)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'shopify-001', 'shopify', 'Shopify', 'oauth2', TRUE, 'ecommerce', 'commerce',
  'Track orders, customers, and revenue from Shopify',
  'SiShopify', '#96BF48', 41,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"order","name":"Order","description":"Customer orders","fields":["order_total","discount_code","fulfillment_status","refund_cents"],"statuses":["paid","partially_paid","partially_refunded","refunded","voided"],"default_status":["paid","partially_paid"]}
  ]'),
  'bg-green-50', 'border-green-200', 'text-green-700',
  TRUE, 'total_cents',
  'Read access to orders, customers, and products',
  'shopify'
);

-- Jobber (field_service)
-- Sync writer: job (completed/in_progress/cancelled), invoice (paid/sent/draft)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'jobber-001', 'jobber', 'Jobber', 'oauth2', TRUE, 'field_service', 'operations',
  'Track jobs, invoices, and clients from Jobber',
  'SiJobber', '#7AC142', 42,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"job","name":"Job Completed","description":"Service jobs","fields":["job_total","scheduled_date","lead_source"],"statuses":["completed","in_progress","cancelled"],"default_status":["completed"]},
    {"id":"invoice","name":"Invoice","description":"Customer invoices","fields":["invoice_total","payment_status","due_date"],"statuses":["paid","sent","draft"],"default_status":["paid"]}
  ]'),
  'bg-green-50', 'border-green-200', 'text-green-700',
  TRUE, 'total_cents',
  'Read access to jobs, invoices, and clients',
  'jobber'
);

-- HubSpot (CRM)
-- Sync writer: deal (closedwon/closedlost/appointmentscheduled/qualifiedtobuy/etc)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'hubspot-001', 'hubspot', 'HubSpot', 'oauth2', TRUE, 'crm', 'sales',
  'Track deals, contacts, and pipeline activity from HubSpot',
  'SiHubspot', '#FF7A59', 43,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"deal","name":"Deal","description":"CRM deals","fields":["dealname","amount","pipeline","stage"],"statuses":["closedwon","closedlost","appointmentscheduled","qualifiedtobuy"],"default_status":["closedwon"]}
  ]'),
  'bg-orange-50', 'border-orange-200', 'text-orange-700',
  TRUE, 'conversion_value',
  'Read access to deals, contacts, companies, and pipelines',
  'hubspot'
);

-- Google Ads (ad_platform)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'google-ads-001', 'google', 'Google Ads', 'oauth2', TRUE, 'ad_platform', 'advertising',
  'Track campaigns, ad spend, and conversions from Google Ads',
  'SiGoogleads', '#4285F4', 10,
  TRUE, FALSE, FALSE, FALSE,
  json('[
    {"id":"ad_click","name":"Ad Click","fields":["campaign_id","ad_group_id","keyword"]},
    {"id":"conversion","name":"Conversion","fields":["conversion_action","conversion_value","currency"]}
  ]'),
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  FALSE, NULL,
  'Read access to campaigns, ad groups, ads, and conversion data',
  'google'
);

-- Meta Ads (ad_platform)
-- Action types from Meta Ads API
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'meta-ads-001', 'facebook', 'Meta Ads', 'oauth2', TRUE, 'ad_platform', 'advertising',
  'Track campaigns, ad spend, and conversions from Meta (Facebook & Instagram)',
  'SiMeta', '#1877F2', 11,
  TRUE, FALSE, FALSE, FALSE,
  json('[
    {"id":"offsite_conversion.fb_pixel_purchase","name":"Purchase (Pixel/CAPI)","fields":["value","currency"]},
    {"id":"offsite_conversion.fb_pixel_lead","name":"Lead (Pixel/CAPI)","fields":["value"]},
    {"id":"offsite_conversion.fb_pixel_complete_registration","name":"Registration (Pixel/CAPI)","fields":["value"]},
    {"id":"offsite_conversion.fb_pixel_add_to_cart","name":"Add to Cart (Pixel)","fields":["value","currency"]},
    {"id":"offsite_conversion.fb_pixel_initiate_checkout","name":"Initiate Checkout (Pixel)","fields":["value","currency"]},
    {"id":"offsite_conversion.fb_pixel_add_payment_info","name":"Add Payment Info (Pixel)","fields":["value"]},
    {"id":"offsite_conversion.fb_pixel_view_content","name":"View Content (Pixel)","fields":["value"]},
    {"id":"offsite_conversion.fb_pixel_search","name":"Search (Pixel)","fields":["value"]},
    {"id":"offsite_conversion.fb_pixel_custom","name":"Custom Conversion (Pixel)","fields":["value"]},
    {"id":"omni_purchase","name":"Purchase (Omni-Channel)","fields":["value","currency"]},
    {"id":"onsite_conversion.lead_grouped","name":"Lead Form (On-Platform)","fields":["value"]},
    {"id":"onsite_conversion.messaging_first_reply","name":"Messaging First Reply","fields":["value"]},
    {"id":"link_click","name":"Link Click","fields":["value"]},
    {"id":"landing_page_view","name":"Landing Page View","fields":["value"]},
    {"id":"post_engagement","name":"Post Engagement","fields":["value"]}
  ]'),
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  FALSE, NULL,
  'Read access to ad account campaigns, insights, and conversion data',
  'facebook'
);

-- TikTok Ads (ad_platform)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'tiktok-ads-001', 'tiktok', 'TikTok Ads', 'oauth2', TRUE, 'ad_platform', 'advertising',
  'Track campaigns, ad spend, and conversions from TikTok Ads',
  'SiTiktok', '#000000', 12,
  TRUE, FALSE, FALSE, FALSE,
  json('[
    {"id":"ad_click","name":"Ad Click","fields":["campaign_id","ad_group_id"]},
    {"id":"conversion","name":"Conversion","fields":["conversion_action","conversion_value","currency"]}
  ]'),
  'bg-gray-50', 'border-gray-200', 'text-gray-700',
  FALSE, NULL,
  'Read access to ad account campaigns and reporting data',
  'tiktok'
);

-- Webhook (developer tools)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'webhook-001', 'webhook', 'Webhook', 'api_key', TRUE, 'events', 'finance',
  'Send conversion events via custom webhooks',
  'Webhook', '#10B981', 90,
  FALSE, TRUE, TRUE, FALSE,
  json('[
    {"id":"custom_event","name":"Custom Event","fields":["event_type","value","currency","customer_email"]}
  ]'),
  'bg-emerald-50', 'border-emerald-200', 'text-emerald-700',
  TRUE, 'value',
  'Webhook URL and signing secret for secure event delivery',
  'webhook'
);

-- Attentive (communication — active, webhook-driven)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'attentive-001', 'attentive', 'Attentive', 'api_key', TRUE, 'communication', 'marketing',
  'Track SMS campaigns and subscriber engagement from Attentive',
  'MessageSquare', '#000000', 50,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"sms_sent","name":"SMS Sent","fields":["campaign_id","message_type"],"statuses":["delivered","failed","bounced"],"default_status":["delivered"]},
    {"id":"sms_message_link_click","name":"SMS Clicked","fields":["campaign_id","link_url"],"statuses":["clicked"],"default_status":["clicked"]},
    {"id":"sms_subscribed","name":"Subscriber Opted In","fields":["source","keyword"],"statuses":["opted_in"],"default_status":["opted_in"]}
  ]'),
  'bg-gray-50', 'border-gray-200', 'text-gray-700',
  FALSE, NULL,
  'Read access to campaigns, subscribers, and engagement metrics',
  'attentive'
);

-- Lemon Squeezy (payments — active)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'lemon-squeezy-001', 'lemon_squeezy', 'Lemon Squeezy', 'api_key', TRUE, 'payments', 'commerce',
  'Track orders and subscriptions from Lemon Squeezy',
  'Lemon', '#FFC233', 44,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"order_created","name":"Order Created","fields":["total","currency","customer_email"],"statuses":["paid","pending","refunded"],"default_status":["paid"]},
    {"id":"subscription_created","name":"Subscription Created","fields":["amount","interval","plan"],"statuses":["active","past_due","cancelled"],"default_status":["active"]}
  ]'),
  'bg-yellow-50', 'border-yellow-200', 'text-yellow-700',
  TRUE, 'total',
  'Read access to orders, subscriptions, and customers',
  'lemon_squeezy'
);

-- Paddle (payments — active)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'paddle-001', 'paddle', 'Paddle', 'api_key', TRUE, 'payments', 'commerce',
  'Track transactions and subscriptions from Paddle',
  'CreditCard', '#3363E5', 45,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"transaction_completed","name":"Transaction Completed","fields":["total","currency","customer_email"],"statuses":["completed","pending","refunded"],"default_status":["completed"]},
    {"id":"subscription_created","name":"Subscription Created","fields":["amount","interval","plan"],"statuses":["active","past_due","cancelled"],"default_status":["active"]}
  ]'),
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  TRUE, 'total',
  'Read access to transactions, subscriptions, and customers',
  'paddle'
);

-- Chargebee (payments — active)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'chargebee-001', 'chargebee', 'Chargebee', 'api_key', TRUE, 'payments', 'commerce',
  'Track subscriptions and invoices from Chargebee',
  'CreditCard', '#FF6633', 46,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"invoice_paid","name":"Invoice Paid","fields":["amount","currency","customer_email"],"statuses":["paid","pending","voided"],"default_status":["paid"]},
    {"id":"subscription_created","name":"Subscription Created","fields":["amount","interval","plan"],"statuses":["active","in_trial","cancelled"],"default_status":["active"]}
  ]'),
  'bg-orange-50', 'border-orange-200', 'text-orange-700',
  TRUE, 'amount',
  'Read access to subscriptions, invoices, and customers',
  'chargebee'
);

-- Recurly (payments — active)
INSERT OR REPLACE INTO connector_configs (
  id, provider, name, auth_type, is_active, connector_type, category,
  description, icon_name, icon_color, sort_order,
  supports_sync, supports_realtime, supports_webhooks, is_beta,
  events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  has_actual_value, value_field, permissions_description, platform_id
) VALUES (
  'recurly-001', 'recurly', 'Recurly', 'api_key', TRUE, 'payments', 'commerce',
  'Track subscriptions and invoices from Recurly',
  'CreditCard', '#F5447B', 47,
  TRUE, FALSE, TRUE, FALSE,
  json('[
    {"id":"purchase","name":"Purchase","fields":["amount","currency","customer_email"],"statuses":["paid","pending","refunded"],"default_status":["paid"]},
    {"id":"subscription_created","name":"Subscription Created","fields":["amount","interval","plan"],"statuses":["active","in_trial","cancelled"],"default_status":["active"]}
  ]'),
  'bg-pink-50', 'border-pink-200', 'text-pink-700',
  TRUE, 'amount',
  'Read access to subscriptions, invoices, and accounts',
  'recurly'
);
