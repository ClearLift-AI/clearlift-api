-- Grouped migration: unified_reviews
-- Tables: reviews_items, reviews_profiles, reviews_responses, reviews_aggregates

-- Table: reviews_items
CREATE TABLE reviews_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  profile_ref TEXT,
  profile_external_id TEXT,
  reviewer_name TEXT,
  reviewer_id TEXT,
  reviewer_location TEXT,
  reviewer_verified INTEGER DEFAULT 0,
  rating REAL NOT NULL,
  rating_scale INTEGER DEFAULT 5,
  title TEXT,
  body TEXT,
  pros TEXT,
  cons TEXT,
  language TEXT DEFAULT 'en',
  sentiment TEXT,
  sentiment_score REAL,
  helpful_count INTEGER DEFAULT 0,
  not_helpful_count INTEGER DEFAULT 0,
  is_featured INTEGER DEFAULT 0,
  is_incentivized INTEGER DEFAULT 0,
  source_type TEXT,
  product_name TEXT,
  product_version TEXT,
  use_case TEXT,
  company_size TEXT,
  industry TEXT,
  tags TEXT,
  attributes TEXT,
  properties TEXT,
  raw_data TEXT,
  reviewed_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for reviews_items
CREATE INDEX idx_reviews_items_date ON reviews_items(organization_id, reviewed_at);
CREATE INDEX idx_reviews_items_org ON reviews_items(organization_id, source_platform);
CREATE INDEX idx_reviews_items_profile ON reviews_items(organization_id, profile_ref);
CREATE INDEX idx_reviews_items_rating ON reviews_items(organization_id, rating);

-- Table: reviews_profiles
CREATE TABLE reviews_profiles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  profile_url TEXT,
  category TEXT,
  subcategory TEXT,
  total_reviews INTEGER DEFAULT 0,
  average_rating REAL,
  rating_scale INTEGER DEFAULT 5,
  recommendation_rate REAL,
  response_rate REAL,
  response_time_hours REAL,
  claimed INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for reviews_profiles
CREATE INDEX idx_reviews_profiles_org ON reviews_profiles(organization_id, source_platform);

-- Table: reviews_responses
CREATE TABLE reviews_responses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  review_ref TEXT NOT NULL,
  review_external_id TEXT NOT NULL,
  responder_name TEXT,
  responder_role TEXT,
  body TEXT NOT NULL,
  is_public INTEGER DEFAULT 1,
  properties TEXT,
  raw_data TEXT,
  responded_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for reviews_responses
CREATE INDEX idx_reviews_responses_review ON reviews_responses(organization_id, review_ref);

-- Table: reviews_aggregates
CREATE TABLE reviews_aggregates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  profile_ref TEXT,
  profile_external_id TEXT,
  period_type TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  review_count INTEGER DEFAULT 0,
  average_rating REAL,
  rating_1_count INTEGER DEFAULT 0,
  rating_2_count INTEGER DEFAULT 0,
  rating_3_count INTEGER DEFAULT 0,
  rating_4_count INTEGER DEFAULT 0,
  rating_5_count INTEGER DEFAULT 0,
  positive_count INTEGER DEFAULT 0,
  neutral_count INTEGER DEFAULT 0,
  negative_count INTEGER DEFAULT 0,
  response_count INTEGER DEFAULT 0,
  avg_response_time_hours REAL,
  nps_score REAL,
  properties TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, profile_external_id, period_type, period_start)
);

-- Indexes for reviews_aggregates
CREATE INDEX idx_reviews_aggregates_org ON reviews_aggregates(organization_id, source_platform);
