-- Add lead value formula columns to conversion_goals
-- Enables calculated goal values for lead generation businesses
-- Formula: goal_value = avg_deal_value_cents * (close_rate_percent / 100)

-- Average deal value in cents (e.g., $10,000 = 1000000)
ALTER TABLE conversion_goals ADD COLUMN avg_deal_value_cents INTEGER;

-- Close rate as percentage (0-100, e.g., 5 = 5%)
ALTER TABLE conversion_goals ADD COLUMN close_rate_percent INTEGER CHECK(close_rate_percent >= 0 AND close_rate_percent <= 100);

-- Update value_type CHECK constraint to include 'calculated'
-- Note: SQLite doesn't support ALTER COLUMN, and the CHECK constraint in 0054
-- was added with a default so we need to update existing rows

-- Update goals that should use calculated values
-- Goals with both avg_deal_value and close_rate set should use 'calculated'
UPDATE conversion_goals
SET value_type = 'calculated'
WHERE avg_deal_value_cents IS NOT NULL
  AND close_rate_percent IS NOT NULL
  AND value_type = 'from_source';
