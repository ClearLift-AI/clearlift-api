-- Grouped migration: facebook_pages
-- Tables: facebook_pages

-- Table: facebook_pages
CREATE TABLE facebook_pages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  category TEXT,
  category_list TEXT,
  fan_count INTEGER DEFAULT 0,
  followers_count INTEGER DEFAULT 0,
  link TEXT,
  picture_url TEXT,
  cover_url TEXT,
  about TEXT,
  description TEXT,
  website TEXT,
  phone TEXT,
  emails TEXT,
  location TEXT,
  hours TEXT,
  is_published INTEGER DEFAULT 1,
  verification_status TEXT,
  access_token TEXT,
  token_expires_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, page_id)
);

-- Indexes for facebook_pages
CREATE INDEX idx_facebook_pages_account ON facebook_pages(account_id);
CREATE INDEX idx_facebook_pages_org ON facebook_pages(organization_id);
CREATE INDEX idx_facebook_pages_page_id ON facebook_pages(page_id);
