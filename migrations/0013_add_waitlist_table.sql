-- Migration: Add waitlist table
-- Created: 2025-10-24
-- Description: Stores pre-launch waitlist signups from marketing site

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  source TEXT,
  utm TEXT, -- JSON string with UTM parameters
  referrer_id TEXT,
  ip_hash TEXT, -- SHA-256 hash of IP for privacy
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'contacted', 'converted', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Index for looking up by email
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);

-- Index for filtering by status
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);

-- Index for sorting by signup date
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at DESC);
