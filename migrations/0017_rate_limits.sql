-- Table: rate_limits
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  last_request TEXT NOT NULL
);

-- Indexes for rate_limits
CREATE INDEX idx_rate_limits_window_end ON rate_limits(window_end);
