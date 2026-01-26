-- Unified Scheduling/Booking Tables
-- Supports: Calendly, Acuity, Jobber, SimplyBook, Cal.com, Square Appointments

CREATE TABLE IF NOT EXISTS scheduling_customers (
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
  tags TEXT,                           -- JSON array
  custom_fields TEXT,                  -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  created_at_platform TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS scheduling_services (
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
  status TEXT DEFAULT 'active',        -- 'active', 'inactive', 'archived'
  booking_url TEXT,
  color TEXT,
  category TEXT,
  max_bookings_per_day INTEGER,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS scheduling_appointments (
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
  status TEXT NOT NULL,                -- 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'
  cancellation_reason TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT,
  duration_minutes INTEGER,
  location_type TEXT,                  -- 'in_person', 'phone', 'video', 'custom'
  location_details TEXT,
  meeting_url TEXT,
  price_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  payment_status TEXT,                 -- 'pending', 'paid', 'refunded'
  notes TEXT,
  guest_emails TEXT,                   -- JSON array
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  custom_fields TEXT,                  -- JSON
  properties TEXT,                     -- JSON
  raw_data TEXT,
  booked_at TEXT NOT NULL,
  cancelled_at TEXT,
  completed_at TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

CREATE TABLE IF NOT EXISTS scheduling_availability (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  organization_id TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  service_ref TEXT,
  service_external_id TEXT,
  assignee_id TEXT,
  day_of_week INTEGER,                 -- 0=Sunday, 6=Saturday
  start_time TEXT,                     -- HH:MM format
  end_time TEXT,                       -- HH:MM format
  timezone TEXT,
  is_available INTEGER DEFAULT 1,
  properties TEXT,                     -- JSON
  raw_data TEXT,
  last_synced_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(organization_id, source_platform, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scheduling_customers_org ON scheduling_customers(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_scheduling_services_org ON scheduling_services(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_org ON scheduling_appointments(organization_id, source_platform);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_time ON scheduling_appointments(organization_id, start_time);
CREATE INDEX IF NOT EXISTS idx_scheduling_appointments_customer ON scheduling_appointments(organization_id, customer_ref);
