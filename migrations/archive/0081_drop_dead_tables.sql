-- Drop dead tables confirmed to have zero rows and zero code references.
-- Tables were scaffolded but never populated or consumed.
-- Verified: Session 6 audit (2026-02-09)
DROP TABLE IF EXISTS conversion_configs;
DROP TABLE IF EXISTS interaction_nodes;
DROP TABLE IF EXISTS interaction_edges;
DROP TABLE IF EXISTS funnel_metadata;
DROP TABLE IF EXISTS acquisition_instances;
