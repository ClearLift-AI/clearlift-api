-- Unified Accounting Tables
-- Supports: QuickBooks, Xero, FreshBooks, Wave, Zoho Books

CREATE TABLE IF NOT EXISTS accounting_customers (
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
  billing_address TEXT,                -- JSON
  shipping_address TEXT,               -- JSON
  currency TEXT DEFAULT 'USD',
  balance_cents INTEGER DEFAULT 0,
  credit_limit_cents INTEGER,
  payment_terms TEXT,
  tax_exempt INTEGER DEFAULT 0,
  notes TEXT,
  status TEXT DEFAULT 'active',        -- 'active', 'archived'
  properties TEXT,                     -- JSON
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS accounting_invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  invoice_number TEXT,
  status TEXT NOT NULL,                -- 'draft', 'sent', 'paid', 'partial', 'overdue', 'void'
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
  line_items TEXT,                     -- JSON array
  tax_lines TEXT,                      -- JSON array
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  paid_date TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS accounting_expenses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  vendor_ref TEXT,
  vendor_external_id TEXT,
  vendor_name TEXT,
  expense_type TEXT,                   -- 'expense', 'bill', 'receipt'
  status TEXT NOT NULL,                -- 'pending', 'approved', 'paid', 'void'
  payment_type TEXT,                   -- 'cash', 'check', 'credit_card', 'bank_transfer'
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
  line_items TEXT,                     -- JSON array
  attachments TEXT,                    -- JSON array
  expense_date TEXT NOT NULL,
  due_date TEXT,
  paid_date TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS accounting_payments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  invoice_ref TEXT,
  invoice_external_id TEXT,
  payment_type TEXT,                   -- 'customer_payment', 'vendor_payment', 'refund'
  payment_method TEXT,                 -- 'cash', 'check', 'credit_card', 'bank_transfer', 'other'
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  exchange_rate REAL DEFAULT 1.0,
  reference_number TEXT,
  memo TEXT,
  deposit_account_id TEXT,
  deposit_account_name TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  payment_date TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS accounting_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,          -- 'asset', 'liability', 'equity', 'income', 'expense'
  account_subtype TEXT,
  account_number TEXT,
  description TEXT,
  currency TEXT DEFAULT 'USD',
  balance_cents INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  is_system INTEGER DEFAULT 0,
  parent_ref TEXT,
  parent_external_id TEXT,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_accounting_customers_org ON accounting_customers(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_accounting_invoices_org ON accounting_invoices(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_accounting_invoices_customer ON accounting_invoices(organization_id, customer_ref);
CREATE INDEX IF NOT EXISTS idx_accounting_invoices_date ON accounting_invoices(organization_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_accounting_expenses_org ON accounting_expenses(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_accounting_expenses_date ON accounting_expenses(organization_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_accounting_payments_org ON accounting_payments(organization_id, source_platform);
