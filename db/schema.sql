PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
  window_started INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone_numbers TEXT NOT NULL,
  upi_id TEXT NOT NULL,
  logo_url TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS id_sequences (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('customer', 'invoice', 'payment')),
  service_type TEXT NOT NULL CHECK (service_type IN ('cable', 'broadband')),
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (entity_type, service_type)
);

CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY,
  service_type TEXT NOT NULL CHECK (service_type IN ('cable', 'broadband')),
  display_name TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (service_type, normalized_key)
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  service_type TEXT NOT NULL CHECK (service_type IN ('cable', 'broadband')),
  name TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise > 0),
  duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days = 30),
  units TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS plans_service_name_unique
  ON plans(service_type, lower(trim(name)));

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  customer_code TEXT NOT NULL,
  service_type TEXT NOT NULL CHECK (service_type IN ('cable', 'broadband')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  area_id INTEGER NOT NULL REFERENCES areas(id),
  phone TEXT,
  stb_number TEXT,
  plan_id INTEGER REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  installation_date TEXT,
  next_billing_start_date TEXT,
  opening_balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_paise >= 0),
  opening_balance_type TEXT NOT NULL DEFAULT 'due' CHECK (opening_balance_type IN ('due', 'advance')),
  credit_balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (credit_balance_paise >= 0),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (service_type, customer_code)
);

CREATE TABLE IF NOT EXISTS customer_status_history (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  effective_date TEXT NOT NULL CHECK (date(effective_date) = effective_date),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customer_status_history_lookup
  ON customer_status_history(customer_id, effective_date, id);

CREATE TABLE IF NOT EXISTS customer_plan_history (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  plan_name_snapshot TEXT NOT NULL,
  price_paise_snapshot INTEGER NOT NULL CHECK (price_paise_snapshot > 0 AND price_paise_snapshot <= 1000000000000),
  effective_date TEXT NOT NULL CHECK (date(effective_date) = effective_date),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customer_plan_history_lookup
  ON customer_plan_history(customer_id, effective_date, id);

CREATE TABLE IF NOT EXISTS customer_plan_gaps (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  effective_date TEXT NOT NULL CHECK (date(effective_date) = effective_date),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customer_plan_gaps_lookup
  ON customer_plan_gaps(customer_id, effective_date, id);

CREATE UNIQUE INDEX IF NOT EXISTS active_stb_number_unique
  ON customers(service_type, lower(trim(stb_number)))
  WHERE is_deleted = 0 AND stb_number IS NOT NULL AND trim(stb_number) <> '';

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_code TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_type TEXT NOT NULL CHECK (service_type IN ('cable', 'broadband')),
  customer_name_snapshot TEXT NOT NULL,
  area_id_snapshot INTEGER NOT NULL,
  area_name_snapshot TEXT NOT NULL,
  plan_name_snapshot TEXT NOT NULL,
  stb_number_snapshot TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  issued_date TEXT NOT NULL,
  months_billed INTEGER NOT NULL CHECK (months_billed > 0),
  current_period_amount_paise INTEGER NOT NULL CHECK (current_period_amount_paise >= 0),
  previous_due_snapshot_paise INTEGER NOT NULL DEFAULT 0 CHECK (previous_due_snapshot_paise >= 0),
  total_payable_paise INTEGER NOT NULL CHECK (total_payable_paise >= 0),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partial', 'paid')),
  billing_mode TEXT NOT NULL DEFAULT 'normal' CHECK (billing_mode IN ('normal', 'historical')),
  historical_reason TEXT,
  is_combined INTEGER NOT NULL DEFAULT 0 CHECK (is_combined IN (0, 1)),
  is_merged INTEGER NOT NULL DEFAULT 0 CHECK (is_merged IN (0, 1)),
  merged_into_invoice_id INTEGER REFERENCES invoices(id),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (date(period_start) = period_start AND date(period_end) = period_end AND date(issued_date) = issued_date AND date(due_date) = due_date),
  CHECK (period_end = date(period_start, printf('+%d days', months_billed * 30 - 1))),
  UNIQUE (service_type, invoice_code)
);

CREATE INDEX IF NOT EXISTS invoices_customer_period_index ON invoices(customer_id, period_start);

CREATE TABLE IF NOT EXISTS invoice_charges (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  charge_type TEXT NOT NULL CHECK (charge_type IN ('service', 'opening_due')),
  description TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  UNIQUE (invoice_id, charge_type)
);

CREATE TABLE IF NOT EXISTS invoice_merge_items (
  merged_invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  source_invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (merged_invoice_id, source_invoice_id),
  UNIQUE (source_invoice_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  payment_code TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_type TEXT NOT NULL CHECK (service_type IN ('cable', 'broadband')),
  customer_code_snapshot TEXT NOT NULL,
  customer_name_snapshot TEXT NOT NULL,
  area_id_snapshot INTEGER NOT NULL,
  area_name_snapshot TEXT NOT NULL,
  stb_number_snapshot TEXT,
  payment_date TEXT NOT NULL,
  amount_received_paise INTEGER NOT NULL CHECK (amount_received_paise >= 0),
  discount_given_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_given_paise >= 0),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash', 'upi', 'system_credit')),
  notes TEXT,
  request_key TEXT,
  resulting_status TEXT NOT NULL CHECK (resulting_status IN ('settled', 'partial', 'credit_added')),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (service_type, payment_code),
  CHECK ((payment_mode = 'system_credit' AND amount_received_paise = 0 AND discount_given_paise = 0) OR payment_mode IN ('cash', 'upi'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_request_key_unique
  ON payments(service_type, request_key) WHERE request_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_customer_created_index ON payments(customer_id, created_at);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount_cash_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_cash_paise >= 0),
  amount_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_discount_paise >= 0),
  amount_credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_credit_paise >= 0),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  CHECK (amount_cash_paise + amount_discount_paise + amount_credit_paise > 0)
);

CREATE TABLE IF NOT EXISTS payment_charge_allocations (
  id INTEGER PRIMARY KEY,
  payment_allocation_id INTEGER NOT NULL REFERENCES payment_allocations(id),
  invoice_charge_id INTEGER NOT NULL REFERENCES invoice_charges(id),
  amount_cash_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_cash_paise >= 0),
  amount_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_discount_paise >= 0),
  amount_credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_credit_paise >= 0),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  CHECK (amount_cash_paise + amount_discount_paise + amount_credit_paise > 0),
  UNIQUE (payment_allocation_id, invoice_charge_id)
);

CREATE INDEX IF NOT EXISTS payment_charge_allocations_charge_index
  ON payment_charge_allocations(invoice_charge_id);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('customer', 'invoice', 'payment', 'expense', 'plan')),
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_entity_lookup
  ON audit_events(entity_type, entity_id, created_at);

CREATE TRIGGER IF NOT EXISTS customers_area_service_match
BEFORE INSERT ON customers FOR EACH ROW
WHEN (SELECT service_type FROM areas WHERE id = NEW.area_id) <> NEW.service_type
BEGIN SELECT RAISE(ABORT, 'Area belongs to another service'); END;

CREATE TRIGGER IF NOT EXISTS customers_plan_service_match
BEFORE INSERT ON customers FOR EACH ROW
WHEN NEW.plan_id IS NOT NULL AND (SELECT service_type FROM plans WHERE id = NEW.plan_id) <> NEW.service_type
BEGIN SELECT RAISE(ABORT, 'Plan belongs to another service'); END;

CREATE TRIGGER IF NOT EXISTS customers_service_type_immutable
BEFORE UPDATE OF service_type ON customers FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'Customer service type cannot change'); END;

CREATE TRIGGER IF NOT EXISTS customer_identity_immutable
BEFORE UPDATE OF customer_code, opening_balance_paise, opening_balance_type ON customers FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'Customer identity and opening balance cannot change'); END;

CREATE TRIGGER IF NOT EXISTS area_service_type_immutable
BEFORE UPDATE OF service_type ON areas FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'Area service type cannot change'); END;

CREATE TRIGGER IF NOT EXISTS plan_service_type_immutable
BEFORE UPDATE OF service_type ON plans FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'Plan service type cannot change'); END;

CREATE TRIGGER IF NOT EXISTS customers_area_service_match_on_update
BEFORE UPDATE OF area_id ON customers FOR EACH ROW
WHEN (SELECT service_type FROM areas WHERE id = NEW.area_id) <> NEW.service_type
BEGIN SELECT RAISE(ABORT, 'Area belongs to another service'); END;

CREATE TRIGGER IF NOT EXISTS customers_plan_service_match_on_update
BEFORE UPDATE OF plan_id ON customers FOR EACH ROW
WHEN NEW.plan_id IS NOT NULL AND (SELECT service_type FROM plans WHERE id = NEW.plan_id) <> NEW.service_type
BEGIN SELECT RAISE(ABORT, 'Plan belongs to another service'); END;

CREATE TRIGGER IF NOT EXISTS invoice_customer_service_match
BEFORE INSERT ON invoices FOR EACH ROW
WHEN (SELECT service_type FROM customers WHERE id = NEW.customer_id) <> NEW.service_type
BEGIN SELECT RAISE(ABORT, 'Customer belongs to another service'); END;

CREATE TRIGGER IF NOT EXISTS payment_customer_service_match
BEFORE INSERT ON payments FOR EACH ROW
WHEN (SELECT service_type FROM customers WHERE id = NEW.customer_id) <> NEW.service_type
BEGIN SELECT RAISE(ABORT, 'Customer belongs to another service'); END;

CREATE TRIGGER IF NOT EXISTS invoice_service_type_immutable
BEFORE UPDATE OF service_type, customer_id ON invoices FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'Invoice customer and service cannot change'); END;

CREATE TRIGGER IF NOT EXISTS payment_service_type_immutable
BEFORE UPDATE OF service_type, customer_id ON payments FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'Payment customer and service cannot change'); END;

CREATE TRIGGER IF NOT EXISTS allocation_customer_match
BEFORE INSERT ON payment_allocations FOR EACH ROW
WHEN (SELECT customer_id FROM payments WHERE id = NEW.payment_id) <>
     (SELECT customer_id FROM invoices WHERE id = NEW.invoice_id)
BEGIN SELECT RAISE(ABORT, 'Payment and invoice belong to different customers'); END;

CREATE TRIGGER IF NOT EXISTS allocation_service_match
BEFORE INSERT ON payment_allocations FOR EACH ROW
WHEN (SELECT service_type FROM payments WHERE id = NEW.payment_id) <>
     (SELECT service_type FROM invoices WHERE id = NEW.invoice_id)
BEGIN SELECT RAISE(ABORT, 'Payment and invoice belong to different services'); END;

CREATE TRIGGER IF NOT EXISTS allocation_links_immutable
BEFORE UPDATE OF payment_id, invoice_id ON payment_allocations FOR EACH ROW
BEGIN SELECT RAISE(ABORT, 'Allocation links cannot change'); END;

CREATE TRIGGER IF NOT EXISTS invoice_period_no_overlap
BEFORE INSERT ON invoices FOR EACH ROW
WHEN NEW.is_combined = 0 AND EXISTS (
  SELECT 1 FROM invoices existing
  WHERE existing.customer_id = NEW.customer_id
    AND existing.is_deleted = 0 AND existing.is_merged = 0
    AND existing.period_start <= NEW.period_end
    AND existing.period_end >= NEW.period_start
)
BEGIN SELECT RAISE(ABORT, 'Invoice period overlaps existing coverage'); END;
