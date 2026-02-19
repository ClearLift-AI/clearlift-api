-- Grouped migration: unified_forms
-- Tables: forms_definitions, forms_submissions, forms_responses

-- Table: forms_definitions
CREATE TABLE forms_definitions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  form_type TEXT,
  theme TEXT,
  language TEXT DEFAULT 'en',
  is_public INTEGER DEFAULT 1,
  response_count INTEGER DEFAULT 0,
  completion_rate REAL,
  average_time_seconds INTEGER,
  form_url TEXT,
  fields_schema TEXT,
  settings TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for forms_definitions
CREATE INDEX idx_forms_definitions_org ON forms_definitions(organization_id, source_platform);

-- Table: forms_submissions
CREATE TABLE forms_submissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  form_ref TEXT NOT NULL,
  form_external_id TEXT NOT NULL,
  respondent_id TEXT,
  email_hash TEXT,
  phone_hash TEXT,
  status TEXT DEFAULT 'completed',
  score REAL,
  time_to_complete_seconds INTEGER,
  landing_url TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  ip_country TEXT,
  ip_city TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  answers TEXT,
  hidden_fields TEXT,
  calculated_fields TEXT,
  properties TEXT,
  raw_data TEXT,
  started_at TEXT,
  submitted_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for forms_submissions
CREATE INDEX idx_forms_submissions_date ON forms_submissions(organization_id, submitted_at);
CREATE INDEX idx_forms_submissions_form ON forms_submissions(organization_id, form_ref);
CREATE INDEX idx_forms_submissions_org ON forms_submissions(organization_id, source_platform);

-- Table: forms_responses
CREATE TABLE forms_responses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  submission_ref TEXT NOT NULL,
  submission_external_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  field_type TEXT,
  field_title TEXT,
  response_type TEXT,
  response_text TEXT,
  response_number REAL,
  response_boolean INTEGER,
  response_choices TEXT,
  response_file_url TEXT,
  properties TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for forms_responses
CREATE INDEX idx_forms_responses_submission ON forms_responses(organization_id, submission_ref);
