-- Supabase Migration: Stripe Connector Tables
-- This creates all necessary tables for storing Stripe revenue data with metadata filtering

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Stripe revenue data table
CREATE TABLE IF NOT EXISTS stripe_revenue_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  connection_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,

  -- Date and time
  date DATE NOT NULL,
  stripe_created_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Stripe object IDs
  charge_id TEXT UNIQUE NOT NULL,
  payment_intent_id TEXT,
  invoice_id TEXT,
  subscription_id TEXT,
  product_id TEXT,
  price_id TEXT,
  customer_id TEXT,

  -- Financial data
  amount BIGINT NOT NULL, -- Amount in smallest currency unit (cents for USD)
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,

  -- User-defined metadata (JSONB for efficient querying)
  charge_metadata JSONB DEFAULT '{}',
  product_metadata JSONB DEFAULT '{}',
  price_metadata JSONB DEFAULT '{}',
  customer_metadata JSONB DEFAULT '{}',

  -- Calculated fields
  units INTEGER DEFAULT 1,
  net_amount BIGINT,
  fee_amount BIGINT,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_stripe_revenue_connection_date ON stripe_revenue_data(connection_id, date);
CREATE INDEX idx_stripe_revenue_org_date ON stripe_revenue_data(organization_id, date);
CREATE INDEX idx_stripe_revenue_status ON stripe_revenue_data(status);
CREATE INDEX idx_stripe_revenue_customer ON stripe_revenue_data(customer_id);
CREATE INDEX idx_stripe_revenue_product ON stripe_revenue_data(product_id);

-- Create GIN indexes for JSONB metadata queries
CREATE INDEX idx_stripe_charge_metadata ON stripe_revenue_data USING GIN(charge_metadata);
CREATE INDEX idx_stripe_product_metadata ON stripe_revenue_data USING GIN(product_metadata);
CREATE INDEX idx_stripe_price_metadata ON stripe_revenue_data USING GIN(price_metadata);
CREATE INDEX idx_stripe_customer_metadata ON stripe_revenue_data USING GIN(customer_metadata);

-- Daily aggregates for faster reporting
CREATE TABLE IF NOT EXISTS stripe_daily_aggregates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  connection_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  date DATE NOT NULL,
  currency TEXT NOT NULL,

  -- Aggregated metrics
  total_revenue BIGINT NOT NULL,
  total_units INTEGER NOT NULL,
  transaction_count INTEGER NOT NULL,
  successful_transaction_count INTEGER NOT NULL,
  failed_transaction_count INTEGER NOT NULL,
  unique_customers INTEGER NOT NULL,

  -- Breakdowns stored as JSONB
  revenue_by_product JSONB DEFAULT '{}',
  revenue_by_status JSONB DEFAULT '{}',
  revenue_by_customer JSONB DEFAULT '{}',
  top_metadata_values JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Ensure one aggregate per connection/date/currency
  UNIQUE(connection_id, date, currency)
);

CREATE INDEX idx_stripe_daily_connection_date ON stripe_daily_aggregates(connection_id, date);
CREATE INDEX idx_stripe_daily_org_date ON stripe_daily_aggregates(organization_id, date);

-- Note: Filter rules configuration is stored in D1 for fast access
-- Only the actual Stripe revenue data is stored in Supabase

-- Metadata discovery cache
CREATE TABLE IF NOT EXISTS stripe_metadata_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  connection_id TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('charge', 'product', 'price', 'customer')),
  key_path TEXT NOT NULL,
  sample_values JSONB DEFAULT '[]',
  value_types TEXT[],
  first_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  occurrence_count INTEGER DEFAULT 1,

  UNIQUE(connection_id, object_type, key_path)
);

CREATE INDEX idx_metadata_keys_connection ON stripe_metadata_keys(connection_id);
CREATE INDEX idx_metadata_keys_type ON stripe_metadata_keys(object_type);

-- Sync tracking specific to Stripe
CREATE TABLE IF NOT EXISTS stripe_sync_state (
  connection_id TEXT PRIMARY KEY,
  last_charge_id TEXT,
  last_sync_timestamp TIMESTAMP WITH TIME ZONE,
  next_sync_from TIMESTAMP WITH TIME ZONE,
  total_charges_synced BIGINT DEFAULT 0,
  total_revenue_synced BIGINT DEFAULT 0,
  failed_sync_attempts INTEGER DEFAULT 0,
  sync_errors JSONB DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
CREATE TRIGGER update_stripe_revenue_data_updated_at
  BEFORE UPDATE ON stripe_revenue_data
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_stripe_daily_aggregates_updated_at
  BEFORE UPDATE ON stripe_daily_aggregates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_stripe_sync_state_updated_at
  BEFORE UPDATE ON stripe_sync_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS)
ALTER TABLE stripe_revenue_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_daily_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_metadata_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_sync_state ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (adjust based on your auth strategy)
-- For now, using service role for all operations
-- In production, you'd want more granular policies based on user roles

-- Example functions for analytics queries
CREATE OR REPLACE FUNCTION get_stripe_revenue_by_metadata(
  p_connection_id TEXT,
  p_date_from DATE,
  p_date_to DATE,
  p_metadata_filters JSONB DEFAULT NULL
)
RETURNS TABLE (
  date DATE,
  total_revenue BIGINT,
  transaction_count BIGINT,
  metadata_grouping JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.date,
    SUM(s.amount)::BIGINT as total_revenue,
    COUNT(*)::BIGINT as transaction_count,
    jsonb_object_agg(
      COALESCE(s.charge_metadata->>'category', 'uncategorized'),
      SUM(s.amount)
    ) as metadata_grouping
  FROM stripe_revenue_data s
  WHERE s.connection_id = p_connection_id
    AND s.date BETWEEN p_date_from AND p_date_to
    AND s.status = 'succeeded'
    AND (
      p_metadata_filters IS NULL
      OR s.charge_metadata @> p_metadata_filters
    )
  GROUP BY s.date
  ORDER BY s.date DESC;
END;
$$ LANGUAGE plpgsql;

-- Function to aggregate daily revenue
CREATE OR REPLACE FUNCTION calculate_stripe_daily_aggregate(
  p_connection_id TEXT,
  p_date DATE
)
RETURNS VOID AS $$
DECLARE
  v_organization_id TEXT;
  v_currency TEXT;
BEGIN
  -- Get organization_id from the first record
  SELECT DISTINCT organization_id, currency
  INTO v_organization_id, v_currency
  FROM stripe_revenue_data
  WHERE connection_id = p_connection_id
    AND date = p_date
  LIMIT 1;

  IF v_organization_id IS NULL THEN
    RETURN;
  END IF;

  -- Insert or update the daily aggregate
  INSERT INTO stripe_daily_aggregates (
    connection_id,
    organization_id,
    date,
    currency,
    total_revenue,
    total_units,
    transaction_count,
    successful_transaction_count,
    failed_transaction_count,
    unique_customers,
    revenue_by_product,
    revenue_by_status,
    revenue_by_customer,
    top_metadata_values
  )
  SELECT
    p_connection_id,
    v_organization_id,
    p_date,
    v_currency,
    COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'succeeded' THEN units ELSE 0 END), 0),
    COUNT(*),
    COUNT(CASE WHEN status = 'succeeded' THEN 1 END),
    COUNT(CASE WHEN status = 'failed' THEN 1 END),
    COUNT(DISTINCT customer_id),
    jsonb_object_agg(
      COALESCE(product_id, 'no_product'),
      COALESCE(SUM(amount), 0)
    ) FILTER (WHERE product_id IS NOT NULL),
    jsonb_object_agg(
      status,
      COUNT(*)
    ),
    jsonb_build_object(),  -- Simplified for now
    jsonb_build_object()   -- Simplified for now
  FROM stripe_revenue_data
  WHERE connection_id = p_connection_id
    AND date = p_date
  GROUP BY connection_id
  ON CONFLICT (connection_id, date, currency)
  DO UPDATE SET
    total_revenue = EXCLUDED.total_revenue,
    total_units = EXCLUDED.total_units,
    transaction_count = EXCLUDED.transaction_count,
    successful_transaction_count = EXCLUDED.successful_transaction_count,
    failed_transaction_count = EXCLUDED.failed_transaction_count,
    unique_customers = EXCLUDED.unique_customers,
    revenue_by_product = EXCLUDED.revenue_by_product,
    revenue_by_status = EXCLUDED.revenue_by_status,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Create a view for easier querying
CREATE OR REPLACE VIEW stripe_revenue_summary AS
SELECT
  date,
  connection_id,
  organization_id,
  COUNT(*) as transaction_count,
  SUM(CASE WHEN status = 'succeeded' THEN amount ELSE 0 END) as total_revenue,
  SUM(CASE WHEN status = 'succeeded' THEN units ELSE 0 END) as total_units,
  COUNT(DISTINCT customer_id) as unique_customers,
  COUNT(DISTINCT product_id) as unique_products,
  AVG(CASE WHEN status = 'succeeded' THEN amount ELSE NULL END) as avg_transaction_value
FROM stripe_revenue_data
GROUP BY date, connection_id, organization_id;