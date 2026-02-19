-- Unified Forms/Surveys Tables
-- Supports: Typeform, Jotform, SurveyMonkey, Google Forms, Tally, Formstack

CREATE TABLE IF NOT EXISTS forms_definitions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',        -- 'active', 'closed', 'draft'
  form_type TEXT,                      -- 'form', 'survey', 'quiz', 'poll'
  theme TEXT,
  language TEXT DEFAULT 'en',
  is_public INTEGER DEFAULT 1,
  response_count INTEGER DEFAULT 0,
  completion_rate REAL,
  average_time_seconds INTEGER,
  form_url TEXT,
  fields_schema TEXT,                  -- JSON: field definitions
  settings TEXT,                       -- JSON: form settings
  properties TEXT,                     -- JSON
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS forms_submissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  form_ref TEXT NOT NULL,
  form_external_id TEXT NOT NULL,
  respondent_id TEXT,
  email_hash TEXT,
  phone_hash TEXT,
  status TEXT DEFAULT 'completed',     -- 'partial', 'completed', 'spam'
  score REAL,                          -- For quizzes
  time_to_complete_seconds INTEGER,
  landing_url TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  ip_country TEXT,
  ip_city TEXT,
  device_type TEXT,                    -- 'desktop', 'mobile', 'tablet'
  browser TEXT,
  os TEXT,
  answers TEXT,                        -- JSON: all answers
  hidden_fields TEXT,                  -- JSON: prefilled/hidden values
  calculated_fields TEXT,              -- JSON: computed values
  properties TEXT,                     -- JSON
  raw_data TEXT,
  started_at TEXT,
  submitted_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS forms_responses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  submission_ref TEXT NOT NULL,
  submission_external_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  field_type TEXT,                     -- 'text', 'email', 'number', 'choice', 'rating', etc.
  field_title TEXT,
  response_type TEXT,                  -- 'text', 'number', 'boolean', 'choice', 'file'
  response_text TEXT,
  response_number REAL,
  response_boolean INTEGER,
  response_choices TEXT,               -- JSON array for multi-select
  response_file_url TEXT,
  properties TEXT,                     -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_forms_definitions_org ON forms_definitions(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_forms_submissions_org ON forms_submissions(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_forms_submissions_form ON forms_submissions(organization_id, form_ref);
CREATE INDEX IF NOT EXISTS idx_forms_submissions_date ON forms_submissions(organization_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_forms_responses_submission ON forms_responses(organization_id, submission_ref);
