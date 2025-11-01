-- Update AI decisions impact field from TEXT to REAL (numeric percentage)
-- Since this is pre-production, we drop and recreate the table

DROP TABLE IF EXISTS ai_decisions;

CREATE TABLE ai_decisions (
  decision_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  parameters TEXT NOT NULL,
  reason TEXT NOT NULL,
  impact REAL NOT NULL, -- 7-day CaC impact as percentage (e.g., -23 = 23% reduction)
  confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  applied_at TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_org_status
  ON ai_decisions(org_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_org_confidence
  ON ai_decisions(org_id, confidence, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_expires
  ON ai_decisions(status, expires_at);
