-- Shopify Revenue Data
CREATE TABLE shopify_revenue_data (
  id TEXT PRIMARY KEY, -- connection_id + order_id
  connection_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  date TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT,
  amount INTEGER NOT NULL, -- cents
  currency TEXT NOT NULL,
  status TEXT NOT NULL, -- paid, refunded, etc.
  units INTEGER DEFAULT 1,
  shopify_created_at TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Shopify Daily Aggregates
CREATE TABLE shopify_daily_aggregates (
  id TEXT PRIMARY KEY, -- connection_id + date + currency
  connection_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  date TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_revenue INTEGER NOT NULL,
  total_units INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  avg_transaction_amount INTEGER NOT NULL, -- derived
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_shopify_revenue_conn_date ON shopify_revenue_data(connection_id, date);
CREATE INDEX idx_shopify_aggregates_conn_date ON shopify_daily_aggregates(connection_id, date);
