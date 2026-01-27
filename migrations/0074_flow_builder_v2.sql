-- Flow Builder v2: Enhanced funnel configuration tables
-- Supports acquisition instances, conversion configs, and interaction flow graph

-- =============================================================================
-- ACQUISITION INSTANCES TABLE
-- Tracks individual ad platform instances with custom labels and filters
-- =============================================================================

CREATE TABLE IF NOT EXISTS acquisition_instances (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  label TEXT NOT NULL,
  filter TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_acquisition_instances_org_id ON acquisition_instances(org_id);
CREATE INDEX IF NOT EXISTS idx_acquisition_instances_connector ON acquisition_instances(connector);

-- =============================================================================
-- CONVERSION CONFIGS TABLE
-- Tracks conversion event configurations with filters
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversion_configs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  event TEXT NOT NULL,
  filters TEXT, -- JSON array of FilterCondition
  label TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE(org_id, connector, event)
);

CREATE INDEX IF NOT EXISTS idx_conversion_configs_org_id ON conversion_configs(org_id);
CREATE INDEX IF NOT EXISTS idx_conversion_configs_connector ON conversion_configs(connector);

-- =============================================================================
-- INTERACTION NODES TABLE
-- Stores the graph nodes for the interaction flow canvas
-- =============================================================================

CREATE TABLE IF NOT EXISTS interaction_nodes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('page_view', 'utm', 'event', 'connector_event')),
  label TEXT NOT NULL,
  filter TEXT,
  connector TEXT,
  flow_tag TEXT CHECK(flow_tag IN ('self_serve', 'sales_led', 'enterprise') OR flow_tag IS NULL),
  is_exclusive INTEGER DEFAULT 0,
  is_goal INTEGER DEFAULT 0,
  linked_conversion_sources TEXT, -- JSON array of connector names
  parent_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of parent node IDs
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interaction_nodes_org_id ON interaction_nodes(org_id);
CREATE INDEX IF NOT EXISTS idx_interaction_nodes_flow_tag ON interaction_nodes(flow_tag);
CREATE INDEX IF NOT EXISTS idx_interaction_nodes_is_goal ON interaction_nodes(is_goal);

-- =============================================================================
-- INTERACTION EDGES TABLE
-- Stores the graph edges connecting interaction nodes
-- =============================================================================

CREATE TABLE IF NOT EXISTS interaction_edges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  connection_type TEXT NOT NULL DEFAULT 'weighted' CHECK(connection_type IN ('weighted', 'exclusive')),
  label TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (source) REFERENCES interaction_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target) REFERENCES interaction_nodes(id) ON DELETE CASCADE,
  UNIQUE(org_id, source, target)
);

CREATE INDEX IF NOT EXISTS idx_interaction_edges_org_id ON interaction_edges(org_id);
CREATE INDEX IF NOT EXISTS idx_interaction_edges_source ON interaction_edges(source);
CREATE INDEX IF NOT EXISTS idx_interaction_edges_target ON interaction_edges(target);

-- =============================================================================
-- ADD FLOW BUILDER V2 COLUMNS TO CONVERSION_GOALS
-- Extends existing table with flow tags and hierarchy support
-- =============================================================================

-- NOTE: flow_tag, is_exclusive, and parent_goal_ids columns may already exist
-- from a previous migration. These statements are kept for documentation but
-- the columns were added in migration 0068 or earlier.

-- =============================================================================
-- FUNNEL METADATA TABLE
-- Stores organization-level funnel settings
-- =============================================================================

CREATE TABLE IF NOT EXISTS funnel_metadata (
  org_id TEXT PRIMARY KEY,
  business_type TEXT NOT NULL DEFAULT 'saas' CHECK(business_type IN ('ecommerce', 'saas', 'lead_gen', 'marketer')),
  flow_version INTEGER DEFAULT 2, -- Flow Builder version
  last_modified_at TEXT DEFAULT (datetime('now')),
  last_modified_by TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (last_modified_by) REFERENCES users(id) ON DELETE SET NULL
);

-- =============================================================================
-- TRIGGERS FOR UPDATED_AT
-- =============================================================================

CREATE TRIGGER IF NOT EXISTS trg_acquisition_instances_updated_at
AFTER UPDATE ON acquisition_instances
BEGIN
  UPDATE acquisition_instances SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_conversion_configs_updated_at
AFTER UPDATE ON conversion_configs
BEGIN
  UPDATE conversion_configs SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_interaction_nodes_updated_at
AFTER UPDATE ON interaction_nodes
BEGIN
  UPDATE interaction_nodes SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_funnel_metadata_updated_at
AFTER UPDATE ON funnel_metadata
BEGIN
  UPDATE funnel_metadata SET last_modified_at = datetime('now') WHERE org_id = NEW.org_id;
END;
