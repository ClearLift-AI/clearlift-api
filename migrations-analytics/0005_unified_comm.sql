-- Grouped migration: unified_comm
-- Tables: comm_campaigns, comm_subscribers, comm_engagements, comm_lists, comm_campaign_metrics

-- Table: comm_campaigns
CREATE TABLE comm_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  campaign_type TEXT NOT NULL,
  status TEXT NOT NULL,
  list_id TEXT,
  list_name TEXT,
  audience_count INTEGER,
  subject_line TEXT,
  from_name TEXT,
  from_address TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  completed_at TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for comm_campaigns
CREATE INDEX idx_commc_org ON comm_campaigns(organization_id);
CREATE INDEX idx_commc_org_platform ON comm_campaigns(organization_id, source_platform);
CREATE INDEX idx_commc_sent ON comm_campaigns(organization_id, sent_at DESC);
CREATE INDEX idx_commc_status ON comm_campaigns(organization_id, status);
CREATE INDEX idx_commc_type ON comm_campaigns(organization_id, campaign_type);

-- Table: comm_subscribers
CREATE TABLE comm_subscribers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  phone_hash TEXT,
  email_status TEXT,
  sms_status TEXT,
  push_status TEXT,
  email_consent_at TEXT,
  sms_consent_at TEXT,
  push_consent_at TEXT,
  total_emails_received INTEGER DEFAULT 0,
  total_emails_opened INTEGER DEFAULT 0,
  total_emails_clicked INTEGER DEFAULT 0,
  total_sms_received INTEGER DEFAULT 0,
  total_sms_clicked INTEGER DEFAULT 0,
  email_open_rate REAL DEFAULT 0,
  email_click_rate REAL DEFAULT 0,
  tags TEXT,
  lists TEXT,
  properties TEXT,
  raw_data TEXT,
  subscribed_at TEXT,
  last_engagement_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for comm_subscribers
CREATE INDEX idx_comms_email_hash ON comm_subscribers(organization_id, email_hash);
CREATE INDEX idx_comms_email_status ON comm_subscribers(organization_id, email_status);
CREATE INDEX idx_comms_engagement ON comm_subscribers(organization_id, last_engagement_at DESC);
CREATE INDEX idx_comms_org ON comm_subscribers(organization_id);
CREATE INDEX idx_comms_org_platform ON comm_subscribers(organization_id, source_platform);
CREATE INDEX idx_comms_phone_hash ON comm_subscribers(organization_id, phone_hash);

-- Table: comm_engagements
CREATE TABLE comm_engagements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT,
  campaign_ref TEXT,
  subscriber_ref TEXT,
  campaign_external_id TEXT,
  subscriber_external_id TEXT,
  engagement_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  link_url TEXT,
  link_id TEXT,
  conversion_value_cents INTEGER,
  conversion_type TEXT,
  occurred_at TEXT NOT NULL,
  properties TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for comm_engagements
CREATE INDEX idx_comme_attr ON comm_engagements(organization_id, engagement_type, occurred_at DESC);
CREATE INDEX idx_comme_campaign ON comm_engagements(campaign_ref);
CREATE INDEX idx_comme_channel ON comm_engagements(organization_id, channel, occurred_at DESC);
CREATE INDEX idx_comme_occurred ON comm_engagements(organization_id, occurred_at DESC);
CREATE INDEX idx_comme_org ON comm_engagements(organization_id);
CREATE INDEX idx_comme_subscriber ON comm_engagements(subscriber_ref);
CREATE INDEX idx_comme_type ON comm_engagements(organization_id, engagement_type);

-- Table: comm_lists
CREATE TABLE comm_lists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  list_type TEXT NOT NULL,
  member_count INTEGER DEFAULT 0,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for comm_lists
CREATE INDEX idx_comml_org ON comm_lists(organization_id);
CREATE INDEX idx_comml_org_platform ON comm_lists(organization_id, source_platform);
CREATE INDEX idx_comml_type ON comm_lists(organization_id, list_type);

-- Table: comm_campaign_metrics
CREATE TABLE comm_campaign_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  campaign_ref TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  bounced_count INTEGER DEFAULT 0,
  opened_count INTEGER DEFAULT 0,
  unique_opens INTEGER DEFAULT 0,
  clicked_count INTEGER DEFAULT 0,
  unique_clicks INTEGER DEFAULT 0,
  unsubscribed_count INTEGER DEFAULT 0,
  complained_count INTEGER DEFAULT 0,
  converted_count INTEGER DEFAULT 0,
  conversion_value_cents INTEGER DEFAULT 0,
  open_rate REAL DEFAULT 0,
  click_rate REAL DEFAULT 0,
  click_to_open_rate REAL DEFAULT 0,
  bounce_rate REAL DEFAULT 0,
  unsubscribe_rate REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, campaign_ref, metric_date)
);

-- Indexes for comm_campaign_metrics
CREATE INDEX idx_commcm_campaign ON comm_campaign_metrics(campaign_ref, metric_date DESC);
CREATE INDEX idx_commcm_org_date ON comm_campaign_metrics(organization_id, metric_date DESC);
CREATE INDEX idx_commcm_platform ON comm_campaign_metrics(organization_id, source_platform, metric_date DESC);
