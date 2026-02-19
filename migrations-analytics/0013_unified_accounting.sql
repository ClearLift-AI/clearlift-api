-- Grouped migration: unified_accounting
-- Tables: accounting_accounts, accounting_customers, accounting_invoices, accounting_expenses, accounting_payments

-- Table: accounting_accounts
CREATE TABLE accounting_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  account_subtype TEXT,
  account_number TEXT,
  description TEXT,
  currency TEXT DEFAULT 'USD',
  balance_cents INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  is_system INTEGER DEFAULT 0,
  parent_ref TEXT,
  parent_external_id TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Table: accounting_customers
CREATE TABLE accounting_customers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  phone_hash TEXT,
  display_name TEXT NOT NULL,
  company_name TEXT,
  first_name TEXT,
  last_name TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  currency TEXT DEFAULT 'USD',
  balance_cents INTEGER DEFAULT 0,
  credit_limit_cents INTEGER,
  payment_terms TEXT,
  tax_exempt INTEGER DEFAULT 0,
  notes TEXT,
  status TEXT DEFAULT 'active',
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for accounting_customers
CREATE INDEX idx_accounting_customers_org ON accounting_customers(organization_id, source_platform);

-- Table: accounting_invoices
CREATE TABLE accounting_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  invoice_number TEXT,
  status TEXT NOT NULL,
  subtotal_cents INTEGER DEFAULT 0,
  discount_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  balance_due_cents INTEGER DEFAULT 0,
  amount_paid_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  exchange_rate REAL DEFAULT 1.0,
  memo TEXT,
  terms TEXT,
  po_number TEXT,
  line_items TEXT,
  tax_lines TEXT,
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  paid_date TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for accounting_invoices
CREATE INDEX idx_accounting_invoices_customer ON accounting_invoices(organization_id, customer_ref);
CREATE INDEX idx_accounting_invoices_date ON accounting_invoices(organization_id, invoice_date);
CREATE INDEX idx_accounting_invoices_org ON accounting_invoices(organization_id, source_platform);

-- Table: accounting_expenses
CREATE TABLE accounting_expenses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  vendor_ref TEXT,
  vendor_external_id TEXT,
  vendor_name TEXT,
  expense_type TEXT,
  status TEXT NOT NULL,
  payment_type TEXT,
  account_id TEXT,
  account_name TEXT,
  category TEXT,
  subtotal_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  exchange_rate REAL DEFAULT 1.0,
  description TEXT,
  memo TEXT,
  reference_number TEXT,
  line_items TEXT,
  attachments TEXT,
  expense_date TEXT NOT NULL,
  due_date TEXT,
  paid_date TEXT,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for accounting_expenses
CREATE INDEX idx_accounting_expenses_date ON accounting_expenses(organization_id, expense_date);
CREATE INDEX idx_accounting_expenses_org ON accounting_expenses(organization_id, source_platform);

-- Table: accounting_payments
CREATE TABLE accounting_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  invoice_ref TEXT,
  invoice_external_id TEXT,
  payment_type TEXT,
  payment_method TEXT,
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  exchange_rate REAL DEFAULT 1.0,
  reference_number TEXT,
  memo TEXT,
  deposit_account_id TEXT,
  deposit_account_name TEXT,
  properties TEXT,
  raw_data TEXT,
  payment_date TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for accounting_payments
CREATE INDEX idx_accounting_payments_org ON accounting_payments(organization_id, source_platform);
