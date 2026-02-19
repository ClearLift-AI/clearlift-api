-- Grouped migration: unified_support
-- Tables: support_tickets, support_customers, support_conversations

-- Table: support_tickets
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  assignee_id TEXT,
  assignee_name TEXT,
  ticket_number TEXT,
  subject TEXT,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT,
  ticket_type TEXT,
  channel TEXT,
  tags TEXT,
  custom_fields TEXT,
  satisfaction_rating TEXT,
  satisfaction_comment TEXT,
  first_response_at TEXT,
  first_resolution_at TEXT,
  full_resolution_at TEXT,
  reopened_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  properties TEXT,
  raw_data TEXT,
  opened_at TEXT NOT NULL,
  solved_at TEXT,
  closed_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for support_tickets
CREATE INDEX idx_support_tickets_customer ON support_tickets(organization_id, customer_ref);
CREATE INDEX idx_support_tickets_org ON support_tickets(organization_id, source_platform);
CREATE INDEX idx_support_tickets_status ON support_tickets(organization_id, status);

-- Table: support_customers
CREATE TABLE support_customers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  phone_hash TEXT,
  name TEXT,
  avatar_url TEXT,
  company_name TEXT,
  total_tickets INTEGER DEFAULT 0,
  total_conversations INTEGER DEFAULT 0,
  last_contacted_at TEXT,
  last_replied_at TEXT,
  browser TEXT,
  os TEXT,
  location_city TEXT,
  location_country TEXT,
  custom_attributes TEXT,
  tags TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for support_customers
CREATE INDEX idx_support_customers_org ON support_customers(organization_id, source_platform);

-- Table: support_conversations
CREATE TABLE support_conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  assignee_id TEXT,
  assignee_name TEXT,
  status TEXT NOT NULL,
  state TEXT,
  channel TEXT,
  source TEXT,
  read INTEGER DEFAULT 0,
  priority TEXT,
  tags TEXT,
  custom_attributes TEXT,
  message_count INTEGER DEFAULT 0,
  admin_reply_count INTEGER DEFAULT 0,
  user_reply_count INTEGER DEFAULT 0,
  waiting_since TEXT,
  snoozed_until TEXT,
  properties TEXT,
  raw_data TEXT,
  started_at TEXT NOT NULL,
  closed_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for support_conversations
CREATE INDEX idx_support_conversations_org ON support_conversations(organization_id, source_platform);
