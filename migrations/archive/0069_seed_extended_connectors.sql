-- Migration: Seed extended connector registry (15 categories)
-- Part of the unified connector architecture for Flow Builder integration
-- See: clearlift-cron/docs/SHARED_CODE.md §20 Connector Roadmap

-- ============================================================================
-- CRM Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'hubspot-001', 'hubspot', 'HubSpot', 'hubspot', 'oauth2', 'crm', 'sales',
  'Import contacts, deals, and track CRM events from HubSpot',
  'SiHubspot', '#FF7A59', 100,
  TRUE, FALSE, TRUE, FALSE, TRUE,
  TRUE, 'amount',
  '[
    {"id": "contact_created", "name": "Contact Created", "fields": ["email", "firstname", "lastname", "company"]},
    {"id": "deal_created", "name": "Deal Created", "fields": ["dealname", "amount", "pipeline", "stage"]},
    {"id": "deal_won", "name": "Deal Won", "fields": ["dealname", "amount", "closedate"]},
    {"id": "deal_lost", "name": "Deal Lost", "fields": ["dealname", "amount", "reason"]},
    {"id": "form_submitted", "name": "Form Submitted", "fields": ["form_id", "email", "page_url"]}
  ]',
  'bg-orange-50', 'border-orange-200', 'text-orange-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'salesforce-001', 'salesforce', 'Salesforce', 'salesforce', 'oauth2', 'crm', 'sales',
  'Import leads, opportunities, and accounts from Salesforce',
  'SiSalesforce', '#00A1E0', 101,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'amount',
  '[
    {"id": "lead_created", "name": "Lead Created", "fields": ["email", "name", "company", "status"]},
    {"id": "lead_converted", "name": "Lead Converted", "fields": ["email", "account_id", "opportunity_id"]},
    {"id": "opportunity_created", "name": "Opportunity Created", "fields": ["name", "amount", "stage", "close_date"]},
    {"id": "opportunity_won", "name": "Opportunity Won", "fields": ["name", "amount", "close_date"]},
    {"id": "opportunity_lost", "name": "Opportunity Lost", "fields": ["name", "amount", "reason"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'pipedrive-001', 'pipedrive', 'Pipedrive', 'pipedrive', 'oauth2', 'crm', 'sales',
  'Import deals, contacts, and activities from Pipedrive',
  'SiPipedrive', '#21A86B', 102,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'value',
  '[
    {"id": "person_created", "name": "Person Created", "fields": ["name", "email", "phone", "organization"]},
    {"id": "deal_created", "name": "Deal Created", "fields": ["title", "value", "currency", "stage"]},
    {"id": "deal_won", "name": "Deal Won", "fields": ["title", "value", "close_time"]},
    {"id": "deal_lost", "name": "Deal Lost", "fields": ["title", "value", "lost_reason"]}
  ]',
  'bg-green-50', 'border-green-200', 'text-green-700',
  2, 400, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Communication Connectors (Email/SMS Marketing)
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'klaviyo-001', 'klaviyo', 'Klaviyo', 'klaviyo', 'api_key', 'communication', 'marketing',
  'Track email and SMS campaign performance from Klaviyo',
  'SiKlaviyo', '#00C8A8', 110,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'revenue',
  '[
    {"id": "email_opened", "name": "Email Opened", "fields": ["campaign_id", "email", "subject"]},
    {"id": "email_clicked", "name": "Email Clicked", "fields": ["campaign_id", "email", "link_url"]},
    {"id": "email_converted", "name": "Email Converted", "fields": ["campaign_id", "email", "revenue"]},
    {"id": "sms_sent", "name": "SMS Sent", "fields": ["campaign_id", "phone"]},
    {"id": "sms_clicked", "name": "SMS Clicked", "fields": ["campaign_id", "phone", "link_url"]}
  ]',
  'bg-teal-50', 'border-teal-200', 'text-teal-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'mailchimp-001', 'mailchimp', 'Mailchimp', 'mailchimp', 'oauth2', 'communication', 'marketing',
  'Track email campaign performance from Mailchimp',
  'SiMailchimp', '#FFE01B', 111,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "campaign_sent", "name": "Campaign Sent", "fields": ["campaign_id", "subject", "recipients"]},
    {"id": "email_opened", "name": "Email Opened", "fields": ["campaign_id", "email"]},
    {"id": "email_clicked", "name": "Email Clicked", "fields": ["campaign_id", "email", "link_url"]},
    {"id": "unsubscribed", "name": "Unsubscribed", "fields": ["email", "reason"]}
  ]',
  'bg-yellow-50', 'border-yellow-200', 'text-yellow-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'attentive-001', 'attentive', 'Attentive', 'attentive', 'api_key', 'communication', 'marketing',
  'Track SMS marketing campaigns and conversions from Attentive',
  'MessageSquare', '#0066FF', 112,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'revenue',
  '[
    {"id": "sms_sent", "name": "SMS Sent", "fields": ["campaign_id", "subscriber_id"]},
    {"id": "sms_click", "name": "SMS Click", "fields": ["campaign_id", "subscriber_id", "link_url"]},
    {"id": "sms_conversion", "name": "SMS Conversion", "fields": ["campaign_id", "subscriber_id", "revenue"]}
  ]',
  'bg-blue-50', 'border-blue-300', 'text-blue-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Support Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'zendesk-001', 'zendesk', 'Zendesk', 'zendesk', 'oauth2', 'support', 'operations',
  'Track support tickets and customer satisfaction from Zendesk',
  'SiZendesk', '#03363D', 120,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "ticket_created", "name": "Ticket Created", "fields": ["ticket_id", "requester_email", "subject", "priority"]},
    {"id": "ticket_solved", "name": "Ticket Solved", "fields": ["ticket_id", "resolution_time"]},
    {"id": "satisfaction_rated", "name": "Satisfaction Rated", "fields": ["ticket_id", "score", "comment"]}
  ]',
  'bg-gray-50', 'border-gray-300', 'text-gray-700',
  2, 400, 90, 12,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'intercom-001', 'intercom', 'Intercom', 'intercom', 'oauth2', 'support', 'operations',
  'Track conversations and user engagement from Intercom',
  'SiIntercom', '#1F8DED', 121,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "conversation_started", "name": "Conversation Started", "fields": ["conversation_id", "user_email"]},
    {"id": "conversation_closed", "name": "Conversation Closed", "fields": ["conversation_id", "resolution_time"]},
    {"id": "user_message", "name": "User Message", "fields": ["conversation_id", "user_email"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  2, 400, 90, 12,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Scheduling Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'calendly-001', 'calendly', 'Calendly', 'calendly', 'oauth2', 'scheduling', 'operations',
  'Track meeting bookings and scheduling events from Calendly',
  'SiCalendly', '#006BFF', 130,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "meeting_scheduled", "name": "Meeting Scheduled", "fields": ["event_type", "invitee_email", "start_time"]},
    {"id": "meeting_cancelled", "name": "Meeting Cancelled", "fields": ["event_type", "invitee_email", "reason"]},
    {"id": "meeting_completed", "name": "Meeting Completed", "fields": ["event_type", "invitee_email", "duration"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'acuity-001', 'acuity', 'Acuity Scheduling', 'acuity', 'oauth2', 'scheduling', 'operations',
  'Track appointment bookings from Acuity Scheduling',
  'Calendar', '#3A82EF', 131,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "appointment_scheduled", "name": "Appointment Scheduled", "fields": ["appointment_type", "email", "datetime"]},
    {"id": "appointment_cancelled", "name": "Appointment Cancelled", "fields": ["appointment_type", "email", "reason"]},
    {"id": "appointment_completed", "name": "Appointment Completed", "fields": ["appointment_type", "email"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Forms Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'typeform-001', 'typeform', 'Typeform', 'typeform', 'oauth2', 'forms', 'marketing',
  'Track form submissions and responses from Typeform',
  'SiTypeform', '#262627', 140,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "form_started", "name": "Form Started", "fields": ["form_id", "response_id"]},
    {"id": "form_submitted", "name": "Form Submitted", "fields": ["form_id", "response_id", "email"]},
    {"id": "form_abandoned", "name": "Form Abandoned", "fields": ["form_id", "response_id", "last_question"]}
  ]',
  'bg-gray-50', 'border-gray-300', 'text-gray-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'jotform-001', 'jotform', 'JotForm', 'jotform', 'api_key', 'forms', 'marketing',
  'Track form submissions from JotForm',
  'FileText', '#F09019', 141,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "form_submitted", "name": "Form Submitted", "fields": ["form_id", "submission_id", "email"]},
    {"id": "form_viewed", "name": "Form Viewed", "fields": ["form_id"]}
  ]',
  'bg-orange-50', 'border-orange-200', 'text-orange-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Accounting Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'quickbooks-001', 'quickbooks', 'QuickBooks', 'quickbooks', 'oauth2', 'accounting', 'finance',
  'Import invoices and payments from QuickBooks Online',
  'SiQuickbooks', '#2CA01C', 150,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'total_amount',
  '[
    {"id": "invoice_created", "name": "Invoice Created", "fields": ["invoice_id", "customer_email", "total_amount"]},
    {"id": "invoice_paid", "name": "Invoice Paid", "fields": ["invoice_id", "customer_email", "amount_paid"]},
    {"id": "payment_received", "name": "Payment Received", "fields": ["payment_id", "customer_email", "amount"]}
  ]',
  'bg-green-50', 'border-green-200', 'text-green-700',
  2, 300, 90, 12,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'xero-001', 'xero', 'Xero', 'xero', 'oauth2', 'accounting', 'finance',
  'Import invoices and payments from Xero',
  'SiXero', '#13B5EA', 151,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'total',
  '[
    {"id": "invoice_created", "name": "Invoice Created", "fields": ["invoice_id", "contact_email", "total"]},
    {"id": "invoice_paid", "name": "Invoice Paid", "fields": ["invoice_id", "contact_email", "amount_paid"]},
    {"id": "payment_created", "name": "Payment Created", "fields": ["payment_id", "contact_email", "amount"]}
  ]',
  'bg-cyan-50', 'border-cyan-200', 'text-cyan-700',
  2, 300, 90, 12,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Attribution Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'appsflyer-001', 'appsflyer', 'AppsFlyer', 'appsflyer', 'api_key', 'attribution', 'marketing',
  'Import mobile app attribution data from AppsFlyer',
  'Smartphone', '#000000', 160,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'revenue',
  '[
    {"id": "install", "name": "App Install", "fields": ["campaign_id", "media_source", "device_type"]},
    {"id": "in_app_event", "name": "In-App Event", "fields": ["event_name", "revenue", "currency"]},
    {"id": "attribution", "name": "Attribution", "fields": ["media_source", "campaign", "conversion_type"]}
  ]',
  'bg-gray-50', 'border-gray-300', 'text-gray-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'adjust-001', 'adjust', 'Adjust', 'adjust', 'api_key', 'attribution', 'marketing',
  'Import mobile attribution and analytics from Adjust',
  'Smartphone', '#0055D4', 161,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'revenue',
  '[
    {"id": "install", "name": "App Install", "fields": ["campaign", "network", "platform"]},
    {"id": "session", "name": "App Session", "fields": ["device_id", "session_count"]},
    {"id": "event", "name": "Custom Event", "fields": ["event_token", "revenue", "currency"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Reviews Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'g2-001', 'g2', 'G2', 'g2', 'api_key', 'reviews', 'marketing',
  'Track B2B software reviews and ratings from G2',
  'Star', '#FF492C', 170,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "review_submitted", "name": "Review Submitted", "fields": ["reviewer_email", "rating", "title"]},
    {"id": "profile_viewed", "name": "Profile Viewed", "fields": ["referrer", "page_type"]}
  ]',
  'bg-red-50', 'border-red-200', 'text-red-700',
  2, 200, 90, 24,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'trustpilot-001', 'trustpilot', 'Trustpilot', 'trustpilot', 'api_key', 'reviews', 'marketing',
  'Track customer reviews and ratings from Trustpilot',
  'Star', '#00B67A', 171,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  FALSE, NULL,
  '[
    {"id": "review_created", "name": "Review Created", "fields": ["reviewer_email", "stars", "title"]},
    {"id": "review_replied", "name": "Review Replied", "fields": ["review_id"]}
  ]',
  'bg-green-50', 'border-green-200', 'text-green-700',
  2, 200, 90, 24,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Affiliate Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'impact-001', 'impact', 'Impact', 'impact', 'api_key', 'affiliate', 'marketing',
  'Track affiliate partnerships and commissions from Impact',
  'Users', '#5551FF', 180,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'payout',
  '[
    {"id": "click", "name": "Affiliate Click", "fields": ["partner_id", "campaign_id", "sub_id"]},
    {"id": "conversion", "name": "Affiliate Conversion", "fields": ["partner_id", "order_id", "payout"]},
    {"id": "payout_approved", "name": "Payout Approved", "fields": ["partner_id", "amount"]}
  ]',
  'bg-indigo-50', 'border-indigo-200', 'text-indigo-700',
  2, 300, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'partnerstack-001', 'partnerstack', 'PartnerStack', 'partnerstack', 'api_key', 'affiliate', 'marketing',
  'Track B2B partnerships and referrals from PartnerStack',
  'Users', '#6366F1', 181,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'commission',
  '[
    {"id": "referral_created", "name": "Referral Created", "fields": ["partner_id", "referral_email"]},
    {"id": "referral_converted", "name": "Referral Converted", "fields": ["partner_id", "customer_email", "commission"]},
    {"id": "commission_paid", "name": "Commission Paid", "fields": ["partner_id", "amount"]}
  ]',
  'bg-indigo-50', 'border-indigo-200', 'text-indigo-700',
  2, 300, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Social Connectors
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'linkedin-pages-001', 'linkedin_pages', 'LinkedIn Pages', 'linkedin_pages', 'oauth2', 'social', 'marketing',
  'Track LinkedIn company page engagement and followers',
  'SiLinkedin', '#0A66C2', 190,
  FALSE, TRUE, TRUE, FALSE, FALSE,
  FALSE, NULL,
  '[
    {"id": "post_published", "name": "Post Published", "fields": ["post_id", "content_type"]},
    {"id": "post_engagement", "name": "Post Engagement", "fields": ["post_id", "likes", "comments", "shares"]},
    {"id": "follower_gained", "name": "Follower Gained", "fields": ["follower_count"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  2, 200, 90, 12,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'instagram-business-001', 'instagram_business', 'Instagram Business', 'instagram_business', 'oauth2', 'social', 'marketing',
  'Track Instagram business account metrics and engagement',
  'SiInstagram', '#E4405F', 191,
  FALSE, TRUE, TRUE, FALSE, FALSE,
  FALSE, NULL,
  '[
    {"id": "post_published", "name": "Post Published", "fields": ["media_id", "media_type"]},
    {"id": "post_engagement", "name": "Post Engagement", "fields": ["media_id", "likes", "comments"]},
    {"id": "story_view", "name": "Story View", "fields": ["story_id", "view_count"]}
  ]',
  'bg-pink-50', 'border-pink-200', 'text-pink-700',
  2, 200, 90, 12,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- Additional Payment Connectors (expanding existing payments category)
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'lemon_squeezy-001', 'lemon_squeezy', 'Lemon Squeezy', 'lemon_squeezy', 'api_key', 'payments', 'commerce',
  'Track digital product sales from Lemon Squeezy',
  'Citrus', '#FFC233', 45,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'total_cents',
  '[
    {"id": "order_completed", "name": "Order Completed", "fields": ["total", "currency", "customer_email"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["variant_id", "total"]},
    {"id": "refund_created", "name": "Refund Created", "fields": ["amount", "reason"]}
  ]',
  'bg-yellow-50', 'border-yellow-200', 'text-yellow-700',
  3, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'paddle-001', 'paddle', 'Paddle', 'paddle', 'api_key', 'payments', 'commerce',
  'Track software and SaaS sales from Paddle',
  'Waves', '#3B6BE7', 46,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'total_cents',
  '[
    {"id": "transaction_completed", "name": "Transaction Completed", "fields": ["total", "currency", "customer_id"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["billing_period", "price_id"]},
    {"id": "subscription_cancelled", "name": "Subscription Cancelled", "fields": ["reason"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  3, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'chargebee-001', 'chargebee', 'Chargebee', 'chargebee', 'api_key', 'payments', 'commerce',
  'Track subscription billing from Chargebee',
  'CreditCard', '#FF6600', 47,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'total_cents',
  '[
    {"id": "invoice_paid", "name": "Invoice Paid", "fields": ["total", "currency", "customer_id"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["plan_id", "billing_period"]},
    {"id": "payment_failed", "name": "Payment Failed", "fields": ["amount", "reason"]}
  ]',
  'bg-orange-50', 'border-orange-200', 'text-orange-700',
  3, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'recurly-001', 'recurly', 'Recurly', 'recurly', 'api_key', 'payments', 'commerce',
  'Track subscription billing from Recurly',
  'Repeat', '#24272B', 48,
  FALSE, TRUE, TRUE, FALSE, TRUE,
  TRUE, 'total_cents',
  '[
    {"id": "invoice_paid", "name": "Invoice Paid", "fields": ["total", "currency", "account_email"]},
    {"id": "subscription_created", "name": "Subscription Created", "fields": ["plan_code", "unit_amount"]},
    {"id": "charge_invoice", "name": "Charge Invoice", "fields": ["total", "subtotal"]}
  ]',
  'bg-gray-50', 'border-gray-300', 'text-gray-700',
  3, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');

-- ============================================================================
-- LinkedIn Ads (Additional Ad Platform)
-- ============================================================================

INSERT INTO connector_configs (
  id, provider, name, platform_id, auth_type, connector_type, category,
  description, icon_name, icon_color, sort_order,
  is_active, is_beta, supports_sync, supports_realtime, supports_webhooks,
  has_actual_value, value_field, events_schema,
  theme_bg_color, theme_border_color, theme_text_color,
  default_concurrency, rate_limit_per_hour, default_lookback_days, default_sync_interval_hours,
  created_at, updated_at
) VALUES (
  'linkedin-ads-001', 'linkedin', 'LinkedIn Ads', 'linkedin', 'oauth2', 'ad_platform', 'advertising',
  'Import LinkedIn Ads campaigns and performance metrics',
  'SiLinkedin', '#0A66C2', 35,
  FALSE, TRUE, TRUE, FALSE, FALSE,
  TRUE, 'value',
  '[
    {"id": "ad_impression", "name": "Ad Impression", "fields": ["campaign_id", "creative_id"]},
    {"id": "ad_click", "name": "Ad Click", "fields": ["campaign_id", "creative_id", "li_fat_id"]},
    {"id": "lead_form_submit", "name": "Lead Form Submit", "fields": ["campaign_id", "email", "company"]},
    {"id": "conversion", "name": "Conversion", "fields": ["conversion_id", "value"]}
  ]',
  'bg-blue-50', 'border-blue-200', 'text-blue-700',
  2, 500, 90, 6,
  datetime('now'), datetime('now')
) ON CONFLICT(id) DO UPDATE SET
  events_schema = excluded.events_schema,
  updated_at = datetime('now');
