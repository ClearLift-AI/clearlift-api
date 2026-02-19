-- Grouped migration: jobber
-- Tables: jobber_jobs, jobber_clients, jobber_invoices, jobber_daily_summary

-- Table: jobber_jobs
CREATE TABLE jobber_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  jobber_job_id TEXT NOT NULL,
  job_number TEXT,
  client_id TEXT,
  client_name TEXT,
  client_email_hash TEXT,
  client_phone_hash TEXT,
  client_company_name TEXT,
  title TEXT,
  description TEXT,
  job_type TEXT,
  instructions TEXT,
  property_id TEXT,
  property_address TEXT,
  property_city TEXT,
  property_state TEXT,
  property_country TEXT,
  total_amount_cents INTEGER DEFAULT 0,
  line_items_total_cents INTEGER DEFAULT 0,
  expenses_total_cents INTEGER DEFAULT 0,
  discounts_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  job_status TEXT,
  is_completed INTEGER DEFAULT 0,
  is_invoiced INTEGER DEFAULT 0,
  assigned_to TEXT,
  team_members_count INTEGER DEFAULT 0,
  lead_source TEXT,
  scheduled_start_at TEXT,
  scheduled_end_at TEXT,
  actual_start_at TEXT,
  actual_end_at TEXT,
  completed_at TEXT,
  jobber_created_at TEXT NOT NULL,
  estimated_duration_minutes INTEGER,
  actual_duration_minutes INTEGER,
  is_recurring INTEGER DEFAULT 0,
  recurrence_rule TEXT,
  parent_job_id TEXT,
  tags TEXT,
  custom_fields TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_job_id)
);

-- Indexes for jobber_jobs
CREATE INDEX idx_jj_client ON jobber_jobs(organization_id, client_email_hash);
CREATE INDEX idx_jj_completed ON jobber_jobs(organization_id, completed_at DESC);
CREATE INDEX idx_jj_conn ON jobber_jobs(connection_id, jobber_created_at DESC);
CREATE INDEX idx_jj_org ON jobber_jobs(organization_id, jobber_created_at DESC);
CREATE INDEX idx_jj_source ON jobber_jobs(organization_id, lead_source);
CREATE INDEX idx_jj_status ON jobber_jobs(organization_id, job_status);

-- Table: jobber_clients
CREATE TABLE jobber_clients (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  jobber_client_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  email TEXT,
  email_hash TEXT,
  phone TEXT,
  phone_hash TEXT,
  street_address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  total_jobs INTEGER DEFAULT 0,
  completed_jobs INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  total_paid_cents INTEGER DEFAULT 0,
  outstanding_balance_cents INTEGER DEFAULT 0,
  first_job_at TEXT,
  last_job_at TEXT,
  jobber_created_at TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_client_id)
);

-- Indexes for jobber_clients
CREATE INDEX idx_jc_email ON jobber_clients(organization_id, email_hash);
CREATE INDEX idx_jc_org ON jobber_clients(organization_id);
CREATE INDEX idx_jc_revenue ON jobber_clients(organization_id, total_revenue_cents DESC);

-- Table: jobber_invoices
CREATE TABLE jobber_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  job_id TEXT,
  jobber_invoice_id TEXT NOT NULL,
  invoice_number TEXT,
  jobber_job_id TEXT,
  client_id TEXT,
  client_name TEXT,
  client_email TEXT,
  client_email_hash TEXT,
  subject TEXT,
  message TEXT,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER NOT NULL,
  amount_paid_cents INTEGER DEFAULT 0,
  balance_due_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  status TEXT,
  is_paid INTEGER DEFAULT 0,
  issue_date TEXT,
  due_date TEXT,
  paid_at TEXT,
  jobber_created_at TEXT NOT NULL,
  payment_method TEXT,
  deposit_account TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_invoice_id)
);

-- Indexes for jobber_invoices
CREATE INDEX idx_ji_client ON jobber_invoices(organization_id, client_email_hash);
CREATE INDEX idx_ji_conn ON jobber_invoices(connection_id, jobber_created_at DESC);
CREATE INDEX idx_ji_job ON jobber_invoices(job_id);
CREATE INDEX idx_ji_org ON jobber_invoices(organization_id, jobber_created_at DESC);
CREATE INDEX idx_ji_paid ON jobber_invoices(organization_id, paid_at DESC);
CREATE INDEX idx_ji_status ON jobber_invoices(organization_id, status);

-- Table: jobber_daily_summary
CREATE TABLE jobber_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  jobs_created INTEGER DEFAULT 0,
  jobs_scheduled INTEGER DEFAULT 0,
  jobs_completed INTEGER DEFAULT 0,
  jobs_cancelled INTEGER DEFAULT 0,
  completed_jobs_revenue_cents INTEGER DEFAULT 0,
  avg_job_value_cents INTEGER DEFAULT 0,
  invoices_sent INTEGER DEFAULT 0,
  invoices_sent_total_cents INTEGER DEFAULT 0,
  invoices_paid INTEGER DEFAULT 0,
  invoices_paid_total_cents INTEGER DEFAULT 0,
  invoices_overdue INTEGER DEFAULT 0,
  invoices_overdue_total_cents INTEGER DEFAULT 0,
  unique_clients_served INTEGER DEFAULT 0,
  new_clients INTEGER DEFAULT 0,
  total_scheduled_hours REAL DEFAULT 0,
  total_actual_hours REAL DEFAULT 0,
  jobs_by_lead_source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, summary_date)
);

-- Indexes for jobber_daily_summary
CREATE INDEX idx_jds_conn ON jobber_daily_summary(connection_id, summary_date DESC);
CREATE INDEX idx_jds_org_date ON jobber_daily_summary(organization_id, summary_date DESC);
