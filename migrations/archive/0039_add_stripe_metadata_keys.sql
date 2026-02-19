-- Add stripe_metadata_keys table for caching discovered metadata keys
-- Used by /v1/connectors/:id/filters/discover endpoint

CREATE TABLE IF NOT EXISTS stripe_metadata_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  object_type TEXT NOT NULL,  -- 'charge', 'subscription', 'customer', etc.
  key_path TEXT NOT NULL,     -- e.g., 'order_id', 'plan.tier', 'customer.segment'
  sample_values TEXT,         -- JSON array of sample values
  value_type TEXT,            -- 'string', 'number', 'boolean', etc.
  occurrence_count INTEGER DEFAULT 1,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(connection_id, object_type, key_path)
);

-- Index for connection lookups
CREATE INDEX IF NOT EXISTS idx_stripe_metadata_keys_connection
  ON stripe_metadata_keys(connection_id);

-- Index for object type queries
CREATE INDEX IF NOT EXISTS idx_stripe_metadata_keys_object_type
  ON stripe_metadata_keys(connection_id, object_type);
