-- ============================================================================
-- MIGRATION 0006: Shopify and Jobber Tables
-- ============================================================================
-- Adds Shopify e-commerce and Jobber service business data tables
-- to D1 ANALYTICS_DB.
-- ============================================================================

-- ============================================================================
-- SHOPIFY TABLES
-- E-commerce order and customer data
-- ============================================================================

-- Shopify orders (primary conversion source for e-commerce)
CREATE TABLE IF NOT EXISTS shopify_orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,

  -- Shopify identifiers
  shopify_order_id TEXT NOT NULL,
  order_number TEXT, -- Human-readable order number
  checkout_id TEXT,
  checkout_token TEXT,
  cart_token TEXT,

  -- Customer
  customer_id TEXT,
  customer_email_hash TEXT, -- SHA256 for matching
  customer_first_name TEXT,
  customer_orders_count INTEGER, -- Total orders by this customer

  -- Order financials
  total_price_cents INTEGER NOT NULL,
  subtotal_price_cents INTEGER,
  total_tax_cents INTEGER DEFAULT 0,
  total_discounts_cents INTEGER DEFAULT 0,
  total_shipping_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',

  -- Status
  financial_status TEXT, -- 'pending', 'authorized', 'paid', 'partially_paid', 'refunded', 'voided'
  fulfillment_status TEXT, -- 'fulfilled', 'partial', 'unfulfilled', NULL

  -- Attribution from Shopify
  landing_site TEXT, -- Full URL customer landed on
  landing_site_path TEXT,
  referring_site TEXT, -- Referrer URL
  source_name TEXT, -- 'web', 'pos', 'mobile', etc.

  -- UTM parameters (from landing_site or checkout)
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,

  -- Click IDs (extracted from landing_site URL)
  gclid TEXT,
  fbclid TEXT,
  ttclid TEXT,

  -- Order details
  line_items_count INTEGER DEFAULT 0,
  total_items_quantity INTEGER DEFAULT 0,

  -- Location
  shipping_country TEXT,
  shipping_province TEXT,
  shipping_city TEXT,

  -- Timing
  shopify_created_at TEXT NOT NULL,
  shopify_processed_at TEXT,
  shopify_cancelled_at TEXT,

  -- Metadata
  tags TEXT, -- Shopify order tags
  note TEXT, -- Order notes
  raw_data TEXT, -- JSON of full order data

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, shopify_order_id)
);

CREATE INDEX IF NOT EXISTS idx_so_org ON shopify_orders(organization_id, shopify_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_so_conn ON shopify_orders(connection_id, shopify_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_so_customer ON shopify_orders(organization_id, customer_email_hash);
CREATE INDEX IF NOT EXISTS idx_so_status ON shopify_orders(organization_id, financial_status);
CREATE INDEX IF NOT EXISTS idx_so_gclid ON shopify_orders(gclid);
CREATE INDEX IF NOT EXISTS idx_so_fbclid ON shopify_orders(fbclid);

-- Shopify refunds
CREATE TABLE IF NOT EXISTS shopify_refunds (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  order_id TEXT NOT NULL, -- References shopify_orders.id

  -- Shopify identifiers
  shopify_refund_id TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,

  -- Refund details
  refund_amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  reason TEXT, -- 'customer', 'inventory', 'fraud', 'other'
  note TEXT,

  -- Timing
  shopify_created_at TEXT NOT NULL,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, shopify_refund_id)
);

CREATE INDEX IF NOT EXISTS idx_sr_order ON shopify_refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_sr_org ON shopify_refunds(organization_id, shopify_created_at DESC);

-- Shopify daily summary
CREATE TABLE IF NOT EXISTS shopify_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  summary_date TEXT NOT NULL, -- YYYY-MM-DD

  -- Order metrics
  order_count INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  total_tax_cents INTEGER DEFAULT 0,
  total_shipping_cents INTEGER DEFAULT 0,
  total_discounts_cents INTEGER DEFAULT 0,

  -- Refund metrics
  refund_count INTEGER DEFAULT 0,
  refund_amount_cents INTEGER DEFAULT 0,

  -- Net metrics
  net_revenue_cents INTEGER DEFAULT 0, -- revenue - refunds

  -- Customer metrics
  unique_customers INTEGER DEFAULT 0,
  new_customers INTEGER DEFAULT 0, -- First-time buyers
  returning_customers INTEGER DEFAULT 0,

  -- Order details
  total_items_sold INTEGER DEFAULT 0,
  avg_order_value_cents INTEGER DEFAULT 0,
  avg_items_per_order REAL DEFAULT 0,

  -- Conversion (if we have session data)
  sessions INTEGER DEFAULT 0,
  conversion_rate REAL, -- orders / sessions

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_sds_org_date ON shopify_daily_summary(organization_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_sds_conn ON shopify_daily_summary(connection_id, summary_date DESC);

-- ============================================================================
-- JOBBER TABLES
-- Service business jobs and invoices
-- ============================================================================

-- Jobber jobs (completed jobs = conversions for service businesses)
CREATE TABLE IF NOT EXISTS jobber_jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,

  -- Jobber identifiers
  jobber_job_id TEXT NOT NULL,
  job_number TEXT, -- Human-readable job number

  -- Client
  client_id TEXT,
  client_name TEXT,
  client_email_hash TEXT, -- SHA256 for matching
  client_phone_hash TEXT,
  client_company_name TEXT,

  -- Job details
  title TEXT,
  description TEXT,
  job_type TEXT, -- Service type category
  instructions TEXT,

  -- Property/Location
  property_id TEXT,
  property_address TEXT,
  property_city TEXT,
  property_state TEXT,
  property_country TEXT,

  -- Financials
  total_amount_cents INTEGER DEFAULT 0,
  line_items_total_cents INTEGER DEFAULT 0,
  expenses_total_cents INTEGER DEFAULT 0,
  discounts_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',

  -- Status
  job_status TEXT, -- 'lead', 'assessment', 'quote', 'scheduled', 'in_progress', 'completed', 'invoiced', 'cancelled'
  is_completed INTEGER DEFAULT 0,
  is_invoiced INTEGER DEFAULT 0,

  -- Team
  assigned_to TEXT, -- JSON array of team member names/IDs
  team_members_count INTEGER DEFAULT 0,

  -- Source (how did this lead come in?)
  lead_source TEXT, -- 'website', 'referral', 'google', 'facebook', 'phone', etc.

  -- Timing
  scheduled_start_at TEXT,
  scheduled_end_at TEXT,
  actual_start_at TEXT,
  actual_end_at TEXT,
  completed_at TEXT,
  jobber_created_at TEXT NOT NULL,

  -- Duration
  estimated_duration_minutes INTEGER,
  actual_duration_minutes INTEGER,

  -- Recurrence
  is_recurring INTEGER DEFAULT 0,
  recurrence_rule TEXT,
  parent_job_id TEXT, -- If part of recurring series

  -- Metadata
  tags TEXT, -- JSON array
  custom_fields TEXT, -- JSON object
  raw_data TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_job_id)
);

CREATE INDEX IF NOT EXISTS idx_jj_org ON jobber_jobs(organization_id, jobber_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jj_conn ON jobber_jobs(connection_id, jobber_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jj_client ON jobber_jobs(organization_id, client_email_hash);
CREATE INDEX IF NOT EXISTS idx_jj_status ON jobber_jobs(organization_id, job_status);
CREATE INDEX IF NOT EXISTS idx_jj_completed ON jobber_jobs(organization_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_jj_source ON jobber_jobs(organization_id, lead_source);

-- Jobber invoices
CREATE TABLE IF NOT EXISTS jobber_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  job_id TEXT, -- References jobber_jobs.id (can be NULL for standalone invoices)

  -- Jobber identifiers
  jobber_invoice_id TEXT NOT NULL,
  invoice_number TEXT, -- Human-readable invoice number
  jobber_job_id TEXT, -- Original Jobber job ID

  -- Client
  client_id TEXT,
  client_name TEXT,
  client_email TEXT,
  client_email_hash TEXT,

  -- Invoice details
  subject TEXT,
  message TEXT,

  -- Financials
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER NOT NULL,
  amount_paid_cents INTEGER DEFAULT 0,
  balance_due_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',

  -- Status
  status TEXT, -- 'draft', 'awaiting_payment', 'paid', 'partially_paid', 'overdue', 'bad_debt', 'void'
  is_paid INTEGER DEFAULT 0,

  -- Timing
  issue_date TEXT,
  due_date TEXT,
  paid_at TEXT, -- When fully paid
  jobber_created_at TEXT NOT NULL,

  -- Payment
  payment_method TEXT, -- 'credit_card', 'cash', 'check', 'bank_transfer', etc.
  deposit_account TEXT,

  -- Metadata
  raw_data TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_ji_org ON jobber_invoices(organization_id, jobber_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ji_conn ON jobber_invoices(connection_id, jobber_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ji_job ON jobber_invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_ji_client ON jobber_invoices(organization_id, client_email_hash);
CREATE INDEX IF NOT EXISTS idx_ji_status ON jobber_invoices(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_ji_paid ON jobber_invoices(organization_id, paid_at DESC);

-- Jobber daily summary
CREATE TABLE IF NOT EXISTS jobber_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  summary_date TEXT NOT NULL, -- YYYY-MM-DD

  -- Job metrics
  jobs_created INTEGER DEFAULT 0,
  jobs_scheduled INTEGER DEFAULT 0,
  jobs_completed INTEGER DEFAULT 0,
  jobs_cancelled INTEGER DEFAULT 0,

  -- Revenue from completed jobs
  completed_jobs_revenue_cents INTEGER DEFAULT 0,
  avg_job_value_cents INTEGER DEFAULT 0,

  -- Invoice metrics
  invoices_sent INTEGER DEFAULT 0,
  invoices_sent_total_cents INTEGER DEFAULT 0,
  invoices_paid INTEGER DEFAULT 0,
  invoices_paid_total_cents INTEGER DEFAULT 0,
  invoices_overdue INTEGER DEFAULT 0,
  invoices_overdue_total_cents INTEGER DEFAULT 0,

  -- Client metrics
  unique_clients_served INTEGER DEFAULT 0,
  new_clients INTEGER DEFAULT 0,

  -- Time metrics
  total_scheduled_hours REAL DEFAULT 0,
  total_actual_hours REAL DEFAULT 0,

  -- Lead source breakdown (JSON)
  jobs_by_lead_source TEXT, -- {"google": 5, "referral": 3, ...}

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_jds_org_date ON jobber_daily_summary(organization_id, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_jds_conn ON jobber_daily_summary(connection_id, summary_date DESC);

-- Jobber clients (for customer lifetime value analysis)
CREATE TABLE IF NOT EXISTS jobber_clients (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,

  -- Jobber identifiers
  jobber_client_id TEXT NOT NULL,

  -- Client details
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  email TEXT,
  email_hash TEXT,
  phone TEXT,
  phone_hash TEXT,

  -- Address
  street_address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,

  -- Metrics (updated on sync)
  total_jobs INTEGER DEFAULT 0,
  completed_jobs INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  total_paid_cents INTEGER DEFAULT 0,
  outstanding_balance_cents INTEGER DEFAULT 0,

  -- Timing
  first_job_at TEXT,
  last_job_at TEXT,
  jobber_created_at TEXT NOT NULL,

  -- Status
  is_active INTEGER DEFAULT 1,
  tags TEXT, -- JSON array

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, jobber_client_id)
);

CREATE INDEX IF NOT EXISTS idx_jc_org ON jobber_clients(organization_id);
CREATE INDEX IF NOT EXISTS idx_jc_email ON jobber_clients(organization_id, email_hash);
CREATE INDEX IF NOT EXISTS idx_jc_revenue ON jobber_clients(organization_id, total_revenue_cents DESC);
