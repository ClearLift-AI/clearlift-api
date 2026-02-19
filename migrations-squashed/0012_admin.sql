-- Grouped migration: admin
-- Tables: admin_tasks, admin_task_comments, admin_invites, admin_impersonation_logs

-- Table: admin_tasks
CREATE TABLE admin_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT NOT NULL CHECK (task_type IN ('follow_up', 'investigation', 'support', 'bug', 'feature', 'other')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  connection_id TEXT,
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_date DATETIME,
  reminder_at DATETIME,
  resolution_notes TEXT,
  resolved_at DATETIME,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for admin_tasks
CREATE INDEX idx_admin_tasks_assigned ON admin_tasks(assigned_to);
CREATE INDEX idx_admin_tasks_created_at ON admin_tasks(created_at DESC);
CREATE INDEX idx_admin_tasks_created_by ON admin_tasks(created_by);
CREATE INDEX idx_admin_tasks_due ON admin_tasks(due_date);
CREATE INDEX idx_admin_tasks_org ON admin_tasks(organization_id);
CREATE INDEX idx_admin_tasks_priority ON admin_tasks(priority);
CREATE INDEX idx_admin_tasks_status ON admin_tasks(status);

-- Table: admin_task_comments
CREATE TABLE admin_task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES admin_tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for admin_task_comments
CREATE INDEX idx_admin_task_comments_task ON admin_task_comments(task_id);

-- Table: admin_invites
CREATE TABLE admin_invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'sent',
  sendgrid_message_id TEXT,
  error_message TEXT,
  FOREIGN KEY (sent_by) REFERENCES users(id)
);

-- Indexes for admin_invites
CREATE INDEX idx_admin_invites_email ON admin_invites(email);
CREATE INDEX idx_admin_invites_sent_at ON admin_invites(sent_at);
CREATE INDEX idx_admin_invites_sent_by ON admin_invites(sent_by);

-- Table: admin_impersonation_logs
CREATE TABLE admin_impersonation_logs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  actions_taken INTEGER DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT
);

-- Indexes for admin_impersonation_logs
CREATE INDEX idx_admin_impersonation_admin ON admin_impersonation_logs(admin_user_id);
CREATE INDEX idx_admin_impersonation_target ON admin_impersonation_logs(target_user_id);
