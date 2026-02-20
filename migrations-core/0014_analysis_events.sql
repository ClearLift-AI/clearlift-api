-- Analysis events table for live tool call feed
-- Append-only log of agentic tool calls and phase changes during AI analysis
-- ~200 bytes per row, max ~600 rows per job (200 iterations × ~3 tool calls)
CREATE TABLE IF NOT EXISTS analysis_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  event_type TEXT NOT NULL,  -- 'tool_call' | 'phase_change'
  tool_name TEXT,
  tool_input_summary TEXT,   -- Short human-readable summary (NOT full JSON)
  tool_status TEXT,          -- 'logged' | 'created' | 'appended' | 'skipped' | 'terminating' | 'simulation_required'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (job_id) REFERENCES analysis_jobs(id)
);
CREATE INDEX idx_analysis_events_job ON analysis_events(job_id, id);
