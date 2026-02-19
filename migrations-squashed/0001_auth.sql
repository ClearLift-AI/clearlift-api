-- Grouped migration: auth
-- Tables: users, sessions, password_reset_tokens, email_verification_tokens

-- Table: users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  issuer TEXT NOT NULL,
  access_sub TEXT NOT NULL,
  identity_nonce TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  name TEXT,
  avatar_url TEXT,
  updated_at DATETIME,
  email_encrypted TEXT,
  email_hash TEXT,
  password_hash TEXT,
  email_verified INTEGER DEFAULT 0,
  email_verification_token TEXT,
  email_verified_at DATETIME,
  is_admin INTEGER NOT NULL DEFAULT 0,
  UNIQUE (issuer, access_sub)
);

-- Indexes for users
CREATE INDEX idx_users_email_hash ON users(email_hash);
CREATE INDEX idx_users_email_verification_token ON users(email_verification_token);
CREATE INDEX idx_users_email_verified ON users(email_verified);
CREATE INDEX idx_users_is_admin ON users(is_admin);

-- Table: sessions
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  ip_address_encrypted TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Table: password_reset_tokens
CREATE TABLE password_reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  used INTEGER DEFAULT 0,
  used_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for password_reset_tokens
CREATE INDEX idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);
CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);

-- Table: email_verification_tokens
CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  used BOOLEAN DEFAULT 0,
  used_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes for email_verification_tokens
CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token);
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
