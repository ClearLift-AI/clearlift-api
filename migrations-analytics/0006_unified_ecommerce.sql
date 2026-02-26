-- Grouped migration: unified_ecommerce
-- Tables: ecommerce_customers, ecommerce_orders, ecommerce_order_items, ecommerce_products, ecommerce_refunds

-- Table: ecommerce_customers
CREATE TABLE ecommerce_customers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  phone_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  total_orders INTEGER DEFAULT 0,
  total_spent_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  first_order_at TEXT,
  last_order_at TEXT,
  tags TEXT,
  accepts_marketing INTEGER DEFAULT 0,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for ecommerce_customers
CREATE INDEX idx_ecommerce_customers_org_platform ON ecommerce_customers(organization_id, source_platform);

-- Table: ecommerce_orders
CREATE TABLE ecommerce_orders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  order_number TEXT,
  status TEXT NOT NULL,
  financial_status TEXT,
  fulfillment_status TEXT,
  subtotal_cents INTEGER DEFAULT 0,
  discount_cents INTEGER DEFAULT 0,
  shipping_cents INTEGER DEFAULT 0,
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  item_count INTEGER DEFAULT 0,
  source_name TEXT,
  landing_url TEXT,
  referring_site TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  discount_codes TEXT,
  tags TEXT,
  properties TEXT,
  raw_data TEXT,
  ordered_at TEXT NOT NULL,
  cancelled_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for ecommerce_orders
CREATE INDEX idx_ecommerce_orders_customer ON ecommerce_orders(organization_id, customer_ref);
CREATE INDEX idx_ecommerce_orders_ordered_at ON ecommerce_orders(organization_id, ordered_at);
CREATE INDEX idx_ecommerce_orders_org_platform ON ecommerce_orders(organization_id, source_platform);

-- Table: ecommerce_order_items
CREATE TABLE ecommerce_order_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  order_external_id TEXT NOT NULL,
  product_ref TEXT,
  product_external_id TEXT,
  variant_external_id TEXT,
  sku TEXT,
  name TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  unit_price_cents INTEGER DEFAULT 0,
  total_cents INTEGER DEFAULT 0,
  discount_cents INTEGER DEFAULT 0,
  properties TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for ecommerce_order_items
CREATE INDEX idx_ecommerce_order_items_order ON ecommerce_order_items(organization_id, order_ref);

-- Table: ecommerce_products
CREATE TABLE ecommerce_products (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  vendor TEXT,
  product_type TEXT,
  status TEXT DEFAULT 'active',
  tags TEXT,
  image_url TEXT,
  price_cents INTEGER,
  compare_at_price_cents INTEGER,
  cost_cents INTEGER,
  sku TEXT,
  barcode TEXT,
  inventory_quantity INTEGER,
  weight_grams INTEGER,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for ecommerce_products
CREATE INDEX idx_ecommerce_products_org_platform ON ecommerce_products(organization_id, source_platform);

-- Table: ecommerce_refunds
CREATE TABLE ecommerce_refunds (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  order_external_id TEXT NOT NULL,
  amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  reason TEXT,
  note TEXT,
  refunded_at TEXT NOT NULL,
  properties TEXT,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);
