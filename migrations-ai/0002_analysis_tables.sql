-- ClearLift Hierarchical Analysis Engine Schema
-- Supports multi-provider LLM (Claude + Gemini) for bottom-up ad insights

-- =============================================================================
-- ANALYSIS_PROMPTS
-- =============================================================================
-- Template registry for hierarchical prompts at each level

CREATE TABLE analysis_prompts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT UNIQUE NOT NULL,  -- e.g., 'ad_level', 'campaign_level', 'cross_platform'
  level TEXT NOT NULL,  -- ad, adset, campaign, account, cross_platform
  platform TEXT,  -- null for cross_platform, else: facebook, google, tiktok
  template TEXT NOT NULL,  -- prompt template with {placeholders}
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT
);

CREATE INDEX idx_prompts_level ON analysis_prompts(level);
CREATE INDEX idx_prompts_platform ON analysis_prompts(platform) WHERE platform IS NOT NULL;

-- Seed default templates
INSERT INTO analysis_prompts (slug, level, platform, template) VALUES
  ('ad_level_default', 'ad', NULL,
'Analyze the performance trends for this ad over the past {days} days.

**Ad:** {ad_name}
**Platform:** {platform}

## Metrics
{metrics_table}

Summarize in 2-3 sentences: what''s working, what''s declining, any anomalies.'),

  ('adset_level_default', 'adset', NULL,
'Analyze this ad set''s performance over {days} days.

**Ad Set:** {adset_name}
**Platform:** {platform}

## Ad Set Metrics
{metrics_table}

## Individual Ad Performance
{child_summaries}

Synthesize the patterns in 3-4 sentences. Which ads are carrying performance? Any divergence?'),

  ('campaign_level_default', 'campaign', NULL,
'Analyze this campaign''s performance over {days} days.

**Campaign:** {campaign_name}
**Platform:** {platform}

## Campaign Metrics
{metrics_table}

## Ad Set Performance
{child_summaries}

Provide a 4-5 sentence analysis: portfolio health, top/bottom performers, scaling opportunities.'),

  ('account_level_default', 'account', NULL,
'Analyze this ad account''s performance over {days} days.

**Account:** {account_name}
**Platform:** {platform}

## Account Metrics
{metrics_table}

## Campaign Performance
{child_summaries}

Summarize in 4-5 sentences: account health, budget allocation efficiency, key recommendations.'),

  ('cross_platform_level_default', 'cross_platform', NULL,
'Generate an executive summary for the past {days} days.

**Organization:** {org_name}
**Total Spend:** {total_spend}
**Blended ROAS:** {blended_roas}

## Platform Performance
{child_summaries}

Provide:
1. Portfolio health assessment (1-2 sentences)
2. This week''s priority actions (max 3 bullet points)
3. Budget reallocation recommendations if any');


-- =============================================================================
-- ANALYSIS_LOGS
-- =============================================================================
-- LLM audit trail for all API calls (both Claude and Gemini)

CREATE TABLE analysis_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  level TEXT NOT NULL,  -- ad, adset, campaign, account, cross_platform
  platform TEXT,
  entity_id TEXT,
  entity_name TEXT,

  -- LLM details
  provider TEXT NOT NULL,  -- claude, gemini
  model TEXT NOT NULL,  -- e.g., claude-haiku-4-5, gemini-3.0-pro
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,

  -- Request/Response
  prompt TEXT,  -- hydrated prompt sent
  response TEXT,  -- LLM output

  -- Analysis run context
  analysis_run_id TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_logs_org_created ON analysis_logs(organization_id, created_at DESC);
CREATE INDEX idx_logs_org_level_entity ON analysis_logs(organization_id, level, entity_id);
CREATE INDEX idx_logs_run ON analysis_logs(analysis_run_id) WHERE analysis_run_id IS NOT NULL;


-- =============================================================================
-- ANALYSIS_SUMMARIES
-- =============================================================================
-- Cached analysis results with expiration

CREATE TABLE analysis_summaries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  level TEXT NOT NULL,  -- ad, adset, campaign, account, cross_platform
  platform TEXT,
  entity_id TEXT NOT NULL,
  entity_name TEXT,

  -- Analysis output
  summary TEXT NOT NULL,
  metrics_snapshot TEXT DEFAULT '{}',  -- JSON of metrics used for this analysis

  -- Context
  days INTEGER NOT NULL,  -- lookback window
  analysis_run_id TEXT NOT NULL,  -- groups summaries from same run

  -- Lifecycle
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_summaries_org_run ON analysis_summaries(organization_id, analysis_run_id);
CREATE INDEX idx_summaries_org_level_entity ON analysis_summaries(organization_id, level, entity_id, created_at DESC);
CREATE UNIQUE INDEX idx_summaries_unique ON analysis_summaries(organization_id, level, platform, entity_id, analysis_run_id);


-- =============================================================================
-- ANALYSIS_JOBS
-- =============================================================================
-- Async job tracking for long-running analysis

CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,

  -- Job configuration
  days INTEGER NOT NULL,
  webhook_url TEXT,  -- optional, for notification on completion

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
  total_entities INTEGER,
  processed_entities INTEGER DEFAULT 0,
  current_level TEXT,  -- ad, adset, campaign, account, cross_platform

  -- Results/Errors
  analysis_run_id TEXT,  -- links to analysis_summaries when complete
  error_message TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_jobs_org_status ON analysis_jobs(organization_id, status);
CREATE INDEX idx_jobs_org_created ON analysis_jobs(organization_id, created_at DESC);
CREATE INDEX idx_jobs_status_created ON analysis_jobs(status, created_at) WHERE status IN ('pending', 'running');
