-- Unified Social Media (Organic) Tables
-- Supports: Instagram, Twitter/X, LinkedIn Pages, YouTube, TikTok (organic), Facebook Pages

CREATE TABLE IF NOT EXISTS social_profiles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT NOT NULL,
  bio TEXT,
  profile_url TEXT,
  avatar_url TEXT,
  website_url TEXT,
  is_verified INTEGER DEFAULT 0,
  is_business INTEGER DEFAULT 0,
  category TEXT,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  engagement_rate REAL,
  avg_likes REAL,
  avg_comments REAL,
  avg_shares REAL,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  profile_ref TEXT,
  profile_external_id TEXT,
  post_type TEXT NOT NULL,             -- 'text', 'image', 'video', 'carousel', 'story', 'reel', 'live'
  status TEXT DEFAULT 'published',     -- 'draft', 'scheduled', 'published', 'archived', 'deleted'
  content TEXT,
  media_urls TEXT,                     -- JSON array
  media_type TEXT,                     -- 'image', 'video', 'mixed'
  thumbnail_url TEXT,
  link_url TEXT,
  hashtags TEXT,                       -- JSON array
  mentions TEXT,                       -- JSON array
  location_name TEXT,
  location_id TEXT,
  is_pinned INTEGER DEFAULT 0,
  is_sponsored INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  video_views INTEGER DEFAULT 0,
  video_watch_time_seconds INTEGER DEFAULT 0,
  engagement_rate REAL,
  sentiment_score REAL,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  scheduled_at TEXT,
  published_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS social_followers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  profile_ref TEXT NOT NULL,
  profile_external_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,         -- YYYY-MM-DD
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  new_followers INTEGER DEFAULT 0,
  lost_followers INTEGER DEFAULT 0,
  net_change INTEGER DEFAULT 0,
  follower_demographics TEXT,          -- JSON: age, gender, location breakdown
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, profile_external_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS social_engagements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT,
  post_ref TEXT,
  post_external_id TEXT,
  profile_ref TEXT,
  profile_external_id TEXT,
  engagement_type TEXT NOT NULL,       -- 'like', 'comment', 'share', 'save', 'click', 'mention', 'reply'
  user_external_id TEXT,
  user_name TEXT,
  content TEXT,                        -- For comments/replies
  sentiment TEXT,                      -- 'positive', 'neutral', 'negative'
  is_from_follower INTEGER,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  engaged_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS social_metrics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  profile_ref TEXT,
  profile_external_id TEXT,
  metric_date TEXT NOT NULL,           -- YYYY-MM-DD
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  profile_views INTEGER DEFAULT 0,
  website_clicks INTEGER DEFAULT 0,
  email_clicks INTEGER DEFAULT 0,
  phone_clicks INTEGER DEFAULT 0,
  direction_clicks INTEGER DEFAULT 0,
  posts_count INTEGER DEFAULT 0,
  stories_count INTEGER DEFAULT 0,
  reels_count INTEGER DEFAULT 0,
  total_likes INTEGER DEFAULT 0,
  total_comments INTEGER DEFAULT 0,
  total_shares INTEGER DEFAULT 0,
  total_saves INTEGER DEFAULT 0,
  engagement_rate REAL,
  audience_growth_rate REAL,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, profile_external_id, metric_date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_social_profiles_org ON social_profiles(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_org ON social_posts(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_profile ON social_posts(organization_id, profile_ref);
CREATE INDEX IF NOT EXISTS idx_social_posts_date ON social_posts(organization_id, published_at);
CREATE INDEX IF NOT EXISTS idx_social_followers_profile ON social_followers(organization_id, profile_ref);
CREATE INDEX IF NOT EXISTS idx_social_engagements_post ON social_engagements(organization_id, post_ref);
CREATE INDEX IF NOT EXISTS idx_social_metrics_profile ON social_metrics(organization_id, profile_ref);
CREATE INDEX IF NOT EXISTS idx_social_metrics_date ON social_metrics(organization_id, metric_date);
