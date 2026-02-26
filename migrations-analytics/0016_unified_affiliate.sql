-- Grouped migration: unified_affiliate
-- Tables: affiliate_referrals, affiliate_partners, affiliate_conversions, affiliate_payouts

-- Table: affiliate_referrals
CREATE TABLE affiliate_referrals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  partner_ref TEXT,
  partner_external_id TEXT,
  visitor_id TEXT,
  email_hash TEXT,
  status TEXT NOT NULL,
  referral_code TEXT,
  landing_page TEXT,
  referrer_url TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  ip_country TEXT,
  ip_city TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  click_time TEXT,
  signup_time TEXT,
  conversion_time TEXT,
  properties TEXT,
  raw_data TEXT,
  referred_at TEXT NOT NULL,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for affiliate_referrals
CREATE INDEX idx_affiliate_referrals_date ON affiliate_referrals(organization_id, referred_at);
CREATE INDEX idx_affiliate_referrals_org ON affiliate_referrals(organization_id, source_platform);
CREATE INDEX idx_affiliate_referrals_partner ON affiliate_referrals(organization_id, partner_ref);

-- Table: affiliate_partners
CREATE TABLE affiliate_partners (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  name TEXT NOT NULL,
  company_name TEXT,
  status TEXT NOT NULL,
  partner_type TEXT,
  tier TEXT,
  commission_rate REAL,
  commission_type TEXT,
  payout_method TEXT,
  payout_threshold_cents INTEGER,
  total_referrals INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  total_commission_cents INTEGER DEFAULT 0,
  total_paid_cents INTEGER DEFAULT 0,
  pending_commission_cents INTEGER DEFAULT 0,
  referral_code TEXT,
  referral_link TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  custom_fields TEXT,
  properties TEXT,
  raw_data TEXT,
  approved_at TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for affiliate_partners
CREATE INDEX idx_affiliate_partners_org ON affiliate_partners(organization_id, source_platform);
CREATE INDEX idx_affiliate_partners_status ON affiliate_partners(organization_id, status);

-- Table: affiliate_conversions
CREATE TABLE affiliate_conversions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  partner_ref TEXT,
  partner_external_id TEXT,
  referral_ref TEXT,
  referral_external_id TEXT,
  customer_external_id TEXT,
  conversion_type TEXT NOT NULL,
  status TEXT NOT NULL,
  order_id TEXT,
  product_name TEXT,
  product_sku TEXT,
  quantity INTEGER DEFAULT 1,
  sale_amount_cents INTEGER DEFAULT 0,
  commission_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  is_recurring INTEGER DEFAULT 0,
  subscription_id TEXT,
  coupon_code TEXT,
  rejection_reason TEXT,
  properties TEXT,
  raw_data TEXT,
  converted_at TEXT NOT NULL,
  approved_at TEXT,
  paid_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for affiliate_conversions
CREATE INDEX idx_affiliate_conversions_date ON affiliate_conversions(organization_id, converted_at);
CREATE INDEX idx_affiliate_conversions_org ON affiliate_conversions(organization_id, source_platform);
CREATE INDEX idx_affiliate_conversions_partner ON affiliate_conversions(organization_id, partner_ref);

-- Table: affiliate_payouts
CREATE TABLE affiliate_payouts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  partner_ref TEXT NOT NULL,
  partner_external_id TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INTEGER DEFAULT 0,
  fee_cents INTEGER DEFAULT 0,
  net_amount_cents INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  payout_method TEXT,
  reference_number TEXT,
  conversion_count INTEGER DEFAULT 0,
  period_start TEXT,
  period_end TEXT,
  notes TEXT,
  failure_reason TEXT,
  properties TEXT,
  raw_data TEXT,
  scheduled_at TEXT,
  processed_at TEXT,
  completed_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for affiliate_payouts
CREATE INDEX idx_affiliate_payouts_partner ON affiliate_payouts(organization_id, partner_ref);
