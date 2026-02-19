-- Grouped migration: analysis
-- Tables: analysis_jobs, analysis_logs, analysis_prompts, analysis_summaries

-- Table: analysis_jobs
CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  days INTEGER NOT NULL,
  webhook_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_entities INTEGER,
  processed_entities INTEGER DEFAULT 0,
  current_level TEXT,
  analysis_run_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  stopped_reason TEXT,
  termination_reason TEXT
);

-- Indexes for analysis_jobs
CREATE INDEX idx_jobs_org_created ON analysis_jobs(organization_id, created_at DESC);
CREATE INDEX idx_jobs_org_status ON analysis_jobs(organization_id, status);
CREATE INDEX idx_jobs_status_created ON analysis_jobs(status, created_at) WHERE status IN ('pending', 'running');

-- Table: analysis_logs
CREATE TABLE analysis_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  level TEXT NOT NULL,
  platform TEXT,
  entity_id TEXT,
  entity_name TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  prompt TEXT,
  response TEXT,
  analysis_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Indexes for analysis_logs
CREATE INDEX idx_logs_org_created ON analysis_logs(organization_id, created_at DESC);
CREATE INDEX idx_logs_org_level_entity ON analysis_logs(organization_id, level, entity_id);
CREATE INDEX idx_logs_run ON analysis_logs(analysis_run_id) WHERE analysis_run_id IS NOT NULL;

-- Table: analysis_prompts
CREATE TABLE analysis_prompts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT UNIQUE NOT NULL,
  level TEXT NOT NULL,
  platform TEXT,
  template TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);

-- Indexes for analysis_prompts
CREATE INDEX idx_prompts_level ON analysis_prompts(level);
CREATE INDEX idx_prompts_platform ON analysis_prompts(platform) WHERE platform IS NOT NULL;

-- Table: analysis_summaries
CREATE TABLE analysis_summaries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  level TEXT NOT NULL,
  platform TEXT,
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  summary TEXT NOT NULL,
  metrics_snapshot TEXT DEFAULT '{}',
  days INTEGER NOT NULL,
  analysis_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL
);

-- Indexes for analysis_summaries
CREATE INDEX idx_summaries_org_level_entity ON analysis_summaries(organization_id, level, entity_id, created_at DESC);
CREATE INDEX idx_summaries_org_run ON analysis_summaries(organization_id, analysis_run_id);
CREATE UNIQUE INDEX idx_summaries_unique ON analysis_summaries(organization_id, level, platform, entity_id, analysis_run_id);
