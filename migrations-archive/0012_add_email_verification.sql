-- Add email verification tokens table
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  used BOOLEAN DEFAULT 0,
  used_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Add index for token lookup
CREATE INDEX idx_email_verification_tokens_token ON email_verification_tokens(token);
CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);

-- Ensure email_verified columns exist on users table (already added in migration 0012)
-- ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT 0;
-- ALTER TABLE users ADD COLUMN email_verified_at DATETIME;