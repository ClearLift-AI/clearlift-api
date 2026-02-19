-- Grouped migration: shopify
-- Tables: shopify_orders, shopify_refunds, shopify_daily_summary

-- Table: shopify_orders
CREATE TABLE shopify_orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  order_number TEXT,
  checkout_id TEXT,
  checkout_token TEXT,
  cart_token TEXT,
  customer_id TEXT,
  customer_email_hash TEXT,
  customer_first_name TEXT,
  customer_orders_count INTEGER,
  total_price_cents INTEGER NOT NULL,
  subtotal_price_cents INTEGER,
  total_tax_cents INTEGER DEFAULT 0,
  total_discounts_cents INTEGER DEFAULT 0,
  total_shipping_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  financial_status TEXT,
  fulfillment_status TEXT,
  landing_site TEXT,
  landing_site_path TEXT,
  referring_site TEXT,
  source_name TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  gclid TEXT,
  fbclid TEXT,
  ttclid TEXT,
  line_items_count INTEGER DEFAULT 0,
  total_items_quantity INTEGER DEFAULT 0,
  shipping_country TEXT,
  shipping_province TEXT,
  shipping_city TEXT,
  shopify_created_at TEXT NOT NULL,
  shopify_processed_at TEXT,
  shopify_cancelled_at TEXT,
  tags TEXT,
  note TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  refund_cents INTEGER DEFAULT 0,
  refund_at TEXT,
  refund_status TEXT,
  dedup_key TEXT,
  UNIQUE(organization_id, connection_id, shopify_order_id)
);

-- Indexes for shopify_orders
CREATE INDEX idx_so_conn ON shopify_orders(connection_id, shopify_created_at DESC);
CREATE INDEX idx_so_customer ON shopify_orders(organization_id, customer_email_hash);
CREATE INDEX idx_so_dedup ON shopify_orders(organization_id, dedup_key);
CREATE INDEX idx_so_fbclid ON shopify_orders(fbclid);
CREATE INDEX idx_so_gclid ON shopify_orders(gclid);
CREATE INDEX idx_so_org ON shopify_orders(organization_id, shopify_created_at DESC);
CREATE INDEX idx_so_refund_status ON shopify_orders(organization_id, refund_status);
CREATE INDEX idx_so_status ON shopify_orders(organization_id, financial_status);

-- Table: shopify_refunds
CREATE TABLE shopify_refunds (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  shopify_refund_id TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  refund_amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'USD',
  reason TEXT,
  note TEXT,
  shopify_created_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, shopify_refund_id)
);

-- Indexes for shopify_refunds
CREATE INDEX idx_sr_order ON shopify_refunds(order_id);
CREATE INDEX idx_sr_org ON shopify_refunds(organization_id, shopify_created_at DESC);

-- Table: shopify_daily_summary
CREATE TABLE shopify_daily_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  order_count INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  total_tax_cents INTEGER DEFAULT 0,
  total_shipping_cents INTEGER DEFAULT 0,
  total_discounts_cents INTEGER DEFAULT 0,
  refund_count INTEGER DEFAULT 0,
  refund_amount_cents INTEGER DEFAULT 0,
  net_revenue_cents INTEGER DEFAULT 0,
  unique_customers INTEGER DEFAULT 0,
  new_customers INTEGER DEFAULT 0,
  returning_customers INTEGER DEFAULT 0,
  total_items_sold INTEGER DEFAULT 0,
  avg_order_value_cents INTEGER DEFAULT 0,
  avg_items_per_order REAL DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  conversion_rate REAL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, connection_id, summary_date)
);

-- Indexes for shopify_daily_summary
CREATE INDEX idx_sds_conn ON shopify_daily_summary(connection_id, summary_date DESC);
