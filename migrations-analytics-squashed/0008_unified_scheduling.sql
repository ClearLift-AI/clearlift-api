-- Grouped migration: unified_scheduling
-- Tables: scheduling_services, scheduling_appointments, scheduling_customers

-- Table: scheduling_services
CREATE TABLE scheduling_services (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER,
  buffer_before_minutes INTEGER DEFAULT 0,
  buffer_after_minutes INTEGER DEFAULT 0,
  price_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'active',
  booking_url TEXT,
  color TEXT,
  category TEXT,
  max_bookings_per_day INTEGER,
  properties TEXT,
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for scheduling_services
CREATE INDEX idx_scheduling_services_org ON scheduling_services(organization_id, source_platform);

-- Table: scheduling_appointments
CREATE TABLE scheduling_appointments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  customer_ref TEXT,
  customer_external_id TEXT,
  service_ref TEXT,
  service_external_id TEXT,
  assignee_id TEXT,
  assignee_name TEXT,
  status TEXT NOT NULL,
  cancellation_reason TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT,
  duration_minutes INTEGER,
  location_type TEXT,
  location_details TEXT,
  meeting_url TEXT,
  price_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  payment_status TEXT,
  notes TEXT,
  guest_emails TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  custom_fields TEXT,
  properties TEXT,
  raw_data TEXT,
  booked_at TEXT NOT NULL,
  cancelled_at TEXT,
  completed_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for scheduling_appointments
CREATE INDEX idx_scheduling_appointments_customer ON scheduling_appointments(organization_id, customer_ref);
CREATE INDEX idx_scheduling_appointments_org ON scheduling_appointments(organization_id, source_platform);
CREATE INDEX idx_scheduling_appointments_time ON scheduling_appointments(organization_id, start_time);

-- Table: scheduling_customers
CREATE TABLE scheduling_customers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  email_hash TEXT,
  phone_hash TEXT,
  first_name TEXT,
  last_name TEXT,
  company_name TEXT,
  timezone TEXT,
  total_bookings INTEGER DEFAULT 0,
  total_cancellations INTEGER DEFAULT 0,
  total_no_shows INTEGER DEFAULT 0,
  total_revenue_cents INTEGER DEFAULT 0,
  first_booking_at TEXT,
  last_booking_at TEXT,
  tags TEXT,
  custom_fields TEXT,
  properties TEXT,
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes for scheduling_customers
CREATE INDEX idx_scheduling_customers_org ON scheduling_customers(organization_id, source_platform);
