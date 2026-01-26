-- ============================================================================
-- MIGRATION: Unified Communication Tables
-- ============================================================================
-- Category-based tables for communication platforms (Klaviyo, Mailchimp,
-- Attentive, SendGrid, etc.)
-- Tracks email/SMS campaigns, subscribers, and engagement for attribution.
--
-- Key design decisions:
-- - source_platform identifies the communication platform
-- - email_hash/phone_hash enable identity matching
-- - campaign_type distinguishes email, sms, push, flow
-- - engagement_type tracks the funnel: sent -> delivered -> opened -> clicked -> converted
-- ============================================================================

-- ============================================================================
-- COMMUNICATION CAMPAIGNS
-- ============================================================================
-- Email/SMS campaign records for attribution.

CREATE TABLE IF NOT EXISTS comm_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,       -- 'klaviyo', 'mailchimp', 'attentive', 'sendgrid', 'postmark'
  external_id TEXT NOT NULL,           -- Platform-specific campaign ID
  -- Campaign info
  name TEXT NOT NULL,
  campaign_type TEXT NOT NULL,         -- 'email', 'sms', 'push', 'flow', 'automation'
  status TEXT NOT NULL,                -- 'draft', 'scheduled', 'sending', 'sent', 'canceled'
  -- Targeting
  list_id TEXT,                        -- Target list/segment ID
  list_name TEXT,                      -- Target list/segment name
  audience_count INTEGER,              -- Number of recipients
  -- Content
  subject_line TEXT,                   -- Email subject / SMS preview
  from_name TEXT,
  from_address TEXT,
  -- Timing
  scheduled_at TEXT,
  sent_at TEXT,
  completed_at TEXT,
  -- Platform data
  properties TEXT,                     -- JSON: template_id, tags, etc.
  raw_data TEXT,
  -- Timestamps
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_commc_org ON comm_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_commc_org_platform ON comm_campaigns(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_commc_type ON comm_campaigns(organization_id, campaign_type);
CREATE INDEX IF NOT EXISTS idx_commc_sent ON comm_campaigns(organization_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_commc_status ON comm_campaigns(organization_id, status);

-- ============================================================================
-- COMMUNICATION SUBSCRIBERS
-- ============================================================================
-- Subscriber/contact records for engagement tracking and identity matching.

CREATE TABLE IF NOT EXISTS comm_subscribers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,           -- Platform-specific subscriber ID
  -- Identity (hashed for privacy)
  email_hash TEXT,                     -- SHA256 hash for identity matching
  phone_hash TEXT,                     -- SHA256 hash for identity matching
  -- Subscription status
  email_status TEXT,                   -- 'subscribed', 'unsubscribed', 'bounced', 'complained'
  sms_status TEXT,                     -- 'subscribed', 'unsubscribed'
  push_status TEXT,                    -- 'subscribed', 'unsubscribed'
  -- Consent tracking
  email_consent_at TEXT,
  sms_consent_at TEXT,
  push_consent_at TEXT,
  -- Engagement metrics (lifetime)
  total_emails_received INTEGER DEFAULT 0,
  total_emails_opened INTEGER DEFAULT 0,
  total_emails_clicked INTEGER DEFAULT 0,
  total_sms_received INTEGER DEFAULT 0,
  total_sms_clicked INTEGER DEFAULT 0,
  -- Calculated engagement
  email_open_rate REAL DEFAULT 0,      -- opened / received
  email_click_rate REAL DEFAULT 0,     -- clicked / received
  -- Segmentation
  tags TEXT,                           -- JSON array of tags
  lists TEXT,                          -- JSON array of list IDs
  -- Platform data
  properties TEXT,                     -- JSON: custom fields, preferences
  raw_data TEXT,
  -- Timestamps
  subscribed_at TEXT,                  -- First subscription date
  last_engagement_at TEXT,             -- Last open/click
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_comms_org ON comm_subscribers(organization_id);
CREATE INDEX IF NOT EXISTS idx_comms_org_platform ON comm_subscribers(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_comms_email_hash ON comm_subscribers(organization_id, email_hash);
CREATE INDEX IF NOT EXISTS idx_comms_phone_hash ON comm_subscribers(organization_id, phone_hash);
CREATE INDEX IF NOT EXISTS idx_comms_email_status ON comm_subscribers(organization_id, email_status);
CREATE INDEX IF NOT EXISTS idx_comms_engagement ON comm_subscribers(organization_id, last_engagement_at DESC);

-- ============================================================================
-- COMMUNICATION ENGAGEMENTS
-- ============================================================================
-- Individual engagement events (sent, delivered, opened, clicked, converted).
-- Used for attribution touchpoint tracking.

CREATE TABLE IF NOT EXISTS comm_engagements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT,                    -- Platform event ID (if available)
  -- Relationships
  campaign_ref TEXT,                   -- References comm_campaigns.id (nullable for transactional)
  subscriber_ref TEXT,                 -- References comm_subscribers.id
  campaign_external_id TEXT,           -- Platform campaign ID for reference
  subscriber_external_id TEXT,         -- Platform subscriber ID for reference
  -- Engagement info
  engagement_type TEXT NOT NULL,       -- 'sent', 'delivered', 'opened', 'clicked', 'converted', 'bounced', 'complained', 'unsubscribed'
  channel TEXT NOT NULL,               -- 'email', 'sms', 'push'
  -- Click details (when engagement_type = 'clicked')
  link_url TEXT,                       -- URL that was clicked
  link_id TEXT,                        -- Link identifier from platform
  -- Conversion details (when engagement_type = 'converted')
  conversion_value_cents INTEGER,
  conversion_type TEXT,                -- 'purchase', 'signup', etc.
  -- Timing
  occurred_at TEXT NOT NULL,
  -- Platform data
  properties TEXT,                     -- JSON: device, location, etc.
  -- Timestamps
  created_at TEXT DEFAULT (datetime('now'))
);

-- Note: No unique constraint on engagements - same event can be synced multiple times
-- and we want to capture all events for complete attribution

CREATE INDEX IF NOT EXISTS idx_comme_org ON comm_engagements(organization_id);
CREATE INDEX IF NOT EXISTS idx_comme_campaign ON comm_engagements(campaign_ref);
CREATE INDEX IF NOT EXISTS idx_comme_subscriber ON comm_engagements(subscriber_ref);
CREATE INDEX IF NOT EXISTS idx_comme_type ON comm_engagements(organization_id, engagement_type);
CREATE INDEX IF NOT EXISTS idx_comme_occurred ON comm_engagements(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_comme_channel ON comm_engagements(organization_id, channel, occurred_at DESC);
-- Compound index for attribution queries
CREATE INDEX IF NOT EXISTS idx_comme_attr ON comm_engagements(organization_id, engagement_type, occurred_at DESC);

-- ============================================================================
-- COMMUNICATION CAMPAIGN METRICS (AGGREGATED)
-- ============================================================================
-- Daily aggregated metrics per campaign for dashboards and reporting.

CREATE TABLE IF NOT EXISTS comm_campaign_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,          -- References comm_campaigns.id
  metric_date TEXT NOT NULL,           -- YYYY-MM-DD
  -- Volume metrics
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  bounced_count INTEGER DEFAULT 0,
  -- Engagement metrics
  opened_count INTEGER DEFAULT 0,
  unique_opens INTEGER DEFAULT 0,
  clicked_count INTEGER DEFAULT 0,
  unique_clicks INTEGER DEFAULT 0,
  -- Negative metrics
  unsubscribed_count INTEGER DEFAULT 0,
  complained_count INTEGER DEFAULT 0,
  -- Conversion metrics
  converted_count INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  -- Calculated rates (stored for quick queries)
  open_rate REAL DEFAULT 0,            -- unique_opens / delivered
  click_rate REAL DEFAULT 0,           -- unique_clicks / delivered
  click_to_open_rate REAL DEFAULT 0,   -- unique_clicks / unique_opens
  bounce_rate REAL DEFAULT 0,          -- bounced / sent
  unsubscribe_rate REAL DEFAULT 0,     -- unsubscribed / delivered
  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, campaign_ref, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_commcm_org_date ON comm_campaign_metrics(organization_id, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_commcm_campaign ON comm_campaign_metrics(campaign_ref, metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_commcm_platform ON comm_campaign_metrics(organization_id, source_platform, metric_date DESC);

-- ============================================================================
-- ENGAGEMENT TYPE NORMALIZATION
-- ============================================================================
-- Each platform has different event names. This documents the normalization:
--
-- Klaviyo:
--   Received Email -> 'sent'
--   Opened Email -> 'opened'
--   Clicked Email -> 'clicked'
--   Bounced Email -> 'bounced'
--   Marked Email as Spam -> 'complained'
--   Unsubscribed -> 'unsubscribed'
--   Placed Order -> 'converted'
--
-- Mailchimp:
--   send -> 'sent'
--   open -> 'opened'
--   click -> 'clicked'
--   bounce -> 'bounced'
--   abuse -> 'complained'
--   unsub -> 'unsubscribed'
--
-- SendGrid:
--   delivered -> 'delivered'
--   open -> 'opened'
--   click -> 'clicked'
--   bounce -> 'bounced'
--   spamreport -> 'complained'
--   unsubscribe -> 'unsubscribed'
--
-- Attentive (SMS):
--   message_sent -> 'sent'
--   message_delivered -> 'delivered'
--   link_click -> 'clicked'
--   opt_out -> 'unsubscribed'
--
-- ============================================================================

-- ============================================================================
-- COMMUNICATION LISTS / SEGMENTS
-- ============================================================================
-- Track list/segment definitions for targeting attribution.

CREATE TABLE IF NOT EXISTS comm_lists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,           -- Platform-specific list ID
  -- List info
  name TEXT NOT NULL,
  list_type TEXT NOT NULL,             -- 'list', 'segment', 'tag'
  -- Membership
  member_count INTEGER DEFAULT 0,
  -- Platform data
  properties TEXT,                     -- JSON: definition, criteria, etc.
  raw_data TEXT,
  -- Timestamps
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_comml_org ON comm_lists(organization_id);
CREATE INDEX IF NOT EXISTS idx_comml_org_platform ON comm_lists(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_comml_type ON comm_lists(organization_id, list_type);
