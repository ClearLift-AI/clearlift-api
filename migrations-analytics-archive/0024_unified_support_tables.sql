-- Unified Customer Support Tables
-- Supports: Zendesk, Intercom, Freshdesk, Help Scout, Crisp

CREATE TABLE IF NOT EXISTS support_customers (
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
  custom_attributes TEXT,              -- JSON
  tags TEXT,                           -- JSON array
  properties TEXT,                     -- JSON
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS support_tickets (
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
  status TEXT NOT NULL,                -- 'new', 'open', 'pending', 'on_hold', 'solved', 'closed'
  priority TEXT,                       -- 'low', 'normal', 'high', 'urgent'
  ticket_type TEXT,                    -- 'question', 'incident', 'problem', 'task'
  channel TEXT,                        -- 'email', 'chat', 'phone', 'web', 'api'
  tags TEXT,                           -- JSON array
  custom_fields TEXT,                  -- JSON
  satisfaction_rating TEXT,            -- 'good', 'bad', null
  satisfaction_comment TEXT,
  first_response_at TEXT,
  first_resolution_at TEXT,
  full_resolution_at TEXT,
  reopened_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  opened_at TEXT NOT NULL,
  solved_at TEXT,
  closed_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS support_conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  assignee_id TEXT,
  assignee_name TEXT,
  status TEXT NOT NULL,                -- 'open', 'closed', 'snoozed'
  state TEXT,                          -- 'new', 'unassigned', 'assigned'
  channel TEXT,                        -- 'email', 'chat', 'messenger', 'twitter', etc.
  source TEXT,                         -- 'contact', 'message', 'operator'
  read INTEGER DEFAULT 0,
  priority TEXT,
  tags TEXT,                           -- JSON array
  custom_attributes TEXT,              -- JSON
  message_count INTEGER DEFAULT 0,
  admin_reply_count INTEGER DEFAULT 0,
  user_reply_count INTEGER DEFAULT 0,
  waiting_since TEXT,
  snoozed_until TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  started_at TEXT NOT NULL,
  closed_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  conversation_ref TEXT,
  conversation_external_id TEXT,
  ticket_ref TEXT,
  ticket_external_id TEXT,
  author_type TEXT NOT NULL,           -- 'customer', 'agent', 'bot', 'system'
  author_id TEXT,
  author_name TEXT,
  message_type TEXT,                   -- 'comment', 'note', 'reply', 'assignment'
  body TEXT,
  body_html TEXT,
  is_internal INTEGER DEFAULT 0,
  attachments TEXT,                    -- JSON array
  properties TEXT,                     -- JSON
  raw_data TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_support_customers_org ON support_customers(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON support_tickets(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets(organization_id, customer_ref);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_support_conversations_org ON support_conversations(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(organization_id, conversation_ref);
