-- Table: stripe_metadata_keys
CREATE TABLE stripe_metadata_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  key_path TEXT NOT NULL,
  sample_values TEXT,
  value_type TEXT,
  occurrence_count INTEGER DEFAULT 1,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, object_type, key_path)
);

-- Indexes for stripe_metadata_keys
CREATE INDEX idx_stripe_metadata_keys_connection ON stripe_metadata_keys(connection_id);
CREATE INDEX idx_stripe_metadata_keys_object_type ON stripe_metadata_keys(connection_id, object_type);
