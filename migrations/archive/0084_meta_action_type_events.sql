-- Migration number: 0084 2026-02-13T00:00:00.000Z
-- Expand Meta/Facebook connector events_schema with real pixel action types
-- Previously only 3 generic events (ad_click, lead, purchase); now 15 granular
-- action types matching Meta's actual action_type taxonomy. Enables per-action-type
-- conversion filtering and breakdown charting.

UPDATE connector_configs SET
  events_schema = json('[
    {"id": "offsite_conversion.fb_pixel_purchase", "name": "Purchase (Pixel/CAPI)", "fields": ["campaign_id", "value", "currency"]},
    {"id": "offsite_conversion.fb_pixel_lead", "name": "Lead (Pixel/CAPI)", "fields": ["campaign_id"]},
    {"id": "offsite_conversion.fb_pixel_complete_registration", "name": "Registration (Pixel/CAPI)", "fields": ["campaign_id"]},
    {"id": "offsite_conversion.fb_pixel_add_to_cart", "name": "Add to Cart (Pixel)", "fields": ["campaign_id", "value"]},
    {"id": "offsite_conversion.fb_pixel_initiate_checkout", "name": "Initiate Checkout (Pixel)", "fields": ["campaign_id", "value"]},
    {"id": "offsite_conversion.fb_pixel_view_content", "name": "View Content (Pixel)", "fields": ["campaign_id"]},
    {"id": "offsite_conversion.fb_pixel_add_payment_info", "name": "Add Payment Info (Pixel)", "fields": ["campaign_id"]},
    {"id": "offsite_conversion.fb_pixel_search", "name": "Search (Pixel)", "fields": ["campaign_id"]},
    {"id": "onsite_conversion.lead_grouped", "name": "Lead Form (On-Platform)", "fields": ["campaign_id", "lead_id"]},
    {"id": "onsite_conversion.messaging_conversation_started_7d", "name": "Messenger Conversation", "fields": ["campaign_id"]},
    {"id": "omni_purchase", "name": "Purchase (Omni-Channel)", "fields": ["campaign_id", "value", "currency"]},
    {"id": "omni_add_to_cart", "name": "Add to Cart (Omni)", "fields": ["campaign_id", "value"]},
    {"id": "omni_initiated_checkout", "name": "Checkout Started (Omni)", "fields": ["campaign_id", "value"]},
    {"id": "omni_complete_registration", "name": "Registration (Omni)", "fields": ["campaign_id"]},
    {"id": "omni_view_content", "name": "View Content (Omni)", "fields": ["campaign_id"]}
  ]')
WHERE provider = 'facebook';
