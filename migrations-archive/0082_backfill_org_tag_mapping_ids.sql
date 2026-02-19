-- Migration: Backfill NULL ids in org_tag_mappings
--
-- Bug: Registration endpoint (auth.ts) omitted the `id` column when inserting
-- into org_tag_mappings. TEXT PRIMARY KEY without NOT NULL allows NULL in SQLite,
-- so every registration-created row has id = NULL.
--
-- Fix: Generate a hex UUID for each NULL row.

UPDATE org_tag_mappings
SET id = lower(hex(randomblob(16)))
WHERE id IS NULL;
