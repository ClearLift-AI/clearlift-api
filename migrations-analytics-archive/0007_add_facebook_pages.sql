-- Facebook Pages table for storing connected Facebook Pages
-- Critical for Meta App Review verification

CREATE TABLE IF NOT EXISTS facebook_pages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  category TEXT,
  category_list TEXT, -- JSON array of categories
  fan_count INTEGER DEFAULT 0,
  followers_count INTEGER DEFAULT 0,
  link TEXT,
  picture_url TEXT,
  cover_url TEXT,
  about TEXT,
  description TEXT,
  website TEXT,
  phone TEXT,
  emails TEXT, -- JSON array of emails
  location TEXT, -- JSON object with address info
  hours TEXT, -- JSON object with business hours
  is_published INTEGER DEFAULT 1,
  verification_status TEXT,
  access_token TEXT, -- Page-specific access token (encrypted)
  token_expires_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT, -- Full API response for debugging
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, page_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_facebook_pages_org ON facebook_pages(organization_id);
CREATE INDEX IF NOT EXISTS idx_facebook_pages_page_id ON facebook_pages(page_id);
CREATE INDEX IF NOT EXISTS idx_facebook_pages_account ON facebook_pages(account_id);
