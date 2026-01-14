-- Admin Tasks for internal CRM/Task Manager
-- Migration: 0051_add_admin_tasks.sql

-- Main tasks table
CREATE TABLE IF NOT EXISTS admin_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    task_type TEXT NOT NULL CHECK (task_type IN ('follow_up', 'investigation', 'support', 'bug', 'feature', 'other')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),

    -- Related entities (nullable - task may relate to user, org, or neither)
    organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    connection_id TEXT,

    -- Assignment
    assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Scheduling
    due_date DATETIME,
    reminder_at DATETIME,

    -- Resolution
    resolution_notes TEXT,
    resolved_at DATETIME,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Task comments for collaboration
CREATE TABLE IF NOT EXISTS admin_task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES admin_tasks(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Impersonation audit logs
CREATE TABLE IF NOT EXISTS admin_impersonation_logs (
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

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_admin_tasks_status ON admin_tasks(status);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_priority ON admin_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_assigned ON admin_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_org ON admin_tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_due ON admin_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_created_by ON admin_tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_created_at ON admin_tasks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_task_comments_task ON admin_task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_admin_impersonation_admin ON admin_impersonation_logs(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_impersonation_target ON admin_impersonation_logs(target_user_id);
