-- Attribution Settings for Organizations
-- Configurable attribution models and windows per organization

ALTER TABLE organizations ADD COLUMN attribution_window_days INTEGER DEFAULT 30;
ALTER TABLE organizations ADD COLUMN default_attribution_model TEXT DEFAULT 'last_touch';
ALTER TABLE organizations ADD COLUMN time_decay_half_life_days INTEGER DEFAULT 7;

-- Industry-specific presets:
-- B2C impulse: window=7, half_life=3
-- B2C considered: window=30, half_life=7 (default)
-- B2B SMB: window=60, half_life=14
-- B2B Enterprise: window=90, half_life=30
