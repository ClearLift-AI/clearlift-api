-- Add generic source condition columns to conversion_goals
-- Enables data-driven conversion aggregation from any unified table.
-- Goals with source_table IS NOT NULL are processed by the generic source processor.

ALTER TABLE conversion_goals ADD COLUMN source_table TEXT DEFAULT NULL;
ALTER TABLE conversion_goals ADD COLUMN source_conditions TEXT DEFAULT NULL;
ALTER TABLE conversion_goals ADD COLUMN source_dedup_expression TEXT DEFAULT NULL;
