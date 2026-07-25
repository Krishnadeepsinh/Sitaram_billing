import { createClient } from '@libsql/client'
import { readFile } from 'node:fs/promises'
import { loadEnvFile } from 'node:process'

try { loadEnvFile('.env.local') } catch (error) { if (error?.code !== 'ENOENT') throw error }

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } = process.env
if (!url || (!url.startsWith('file:') && !authToken)) throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before migrating.')
const client = createClient({ url, authToken })
const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')
const existingInvoices = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invoices'")
if (existingInvoices.rows[0]) {
  const transaction = await client.transaction('write')
  try {
    const invoiceColumns = new Set((await transaction.execute('PRAGMA table_info(invoices)')).rows.map((row) => String(row.name)))
    for (const [name, sql] of [
      ['billing_mode', "ALTER TABLE invoices ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'normal' CHECK (billing_mode IN ('normal', 'historical'))"],
      ['historical_reason', 'ALTER TABLE invoices ADD COLUMN historical_reason TEXT'],
      ['is_combined', 'ALTER TABLE invoices ADD COLUMN is_combined INTEGER NOT NULL DEFAULT 0 CHECK (is_combined IN (0, 1))'],
    ]) if (!invoiceColumns.has(name)) await transaction.execute(sql)
    const paymentColumns = new Set((await transaction.execute('PRAGMA table_info(payments)')).rows.map((row) => String(row.name)))
    if (!paymentColumns.has('request_key')) await transaction.execute('ALTER TABLE payments ADD COLUMN request_key TEXT')
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    transaction.close()
  }
}
await client.executeMultiple(schema)
await client.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')

const applied = await client.execute('SELECT version FROM schema_migrations WHERE version = 1')
if (!applied.rows[0]) {
  const transaction = await client.transaction('write')
  try {
    const invoiceColumns = new Set((await transaction.execute('PRAGMA table_info(invoices)')).rows.map((row) => String(row.name)))
    if (!invoiceColumns.has('area_id_snapshot')) await transaction.execute('ALTER TABLE invoices ADD COLUMN area_id_snapshot INTEGER')
    await transaction.execute(`UPDATE invoices SET area_id_snapshot = COALESCE(area_id_snapshot, (SELECT area_id FROM customers WHERE customers.id = invoices.customer_id))`)
    const columns = new Set((await transaction.execute('PRAGMA table_info(payments)')).rows.map((row) => String(row.name)))
    for (const [name, sql] of [
      ['customer_code_snapshot', 'ALTER TABLE payments ADD COLUMN customer_code_snapshot TEXT'],
      ['customer_name_snapshot', 'ALTER TABLE payments ADD COLUMN customer_name_snapshot TEXT'],
      ['area_id_snapshot', 'ALTER TABLE payments ADD COLUMN area_id_snapshot INTEGER'],
      ['area_name_snapshot', 'ALTER TABLE payments ADD COLUMN area_name_snapshot TEXT'],
      ['stb_number_snapshot', 'ALTER TABLE payments ADD COLUMN stb_number_snapshot TEXT'],
    ]) if (!columns.has(name)) await transaction.execute(sql)
    await transaction.execute(`UPDATE payments SET
      customer_code_snapshot = COALESCE(customer_code_snapshot, (SELECT customer_code FROM customers WHERE customers.id = payments.customer_id)),
      customer_name_snapshot = COALESCE(customer_name_snapshot, (SELECT name FROM customers WHERE customers.id = payments.customer_id)),
      area_id_snapshot = COALESCE(area_id_snapshot, (SELECT area_id FROM customers WHERE customers.id = payments.customer_id)),
      area_name_snapshot = COALESCE(area_name_snapshot, (SELECT areas.display_name FROM customers JOIN areas ON areas.id = customers.area_id WHERE customers.id = payments.customer_id)),
      stb_number_snapshot = COALESCE(stb_number_snapshot, (SELECT stb_number FROM customers WHERE customers.id = payments.customer_id))`)
    const missing = await transaction.execute(`SELECT
      (SELECT COUNT(*) FROM invoices WHERE area_id_snapshot IS NULL) +
      (SELECT COUNT(*) FROM payments WHERE customer_code_snapshot IS NULL OR customer_name_snapshot IS NULL OR area_id_snapshot IS NULL OR area_name_snapshot IS NULL) AS count`)
    if (Number(missing.rows[0].count)) throw new Error('Financial history contains orphaned customers. Repair those references before migrating.')
    await transaction.execute('UPDATE plans SET is_active = 0 WHERE price_paise <= 0')
    await transaction.execute('DROP INDEX IF EXISTS active_stb_number_unique')
    await transaction.execute(`CREATE UNIQUE INDEX active_stb_number_unique ON customers(service_type, lower(trim(stb_number)))
      WHERE is_deleted = 0 AND stb_number IS NOT NULL AND trim(stb_number) <> ''`)
    await transaction.execute({ sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)', args: [new Date().toISOString()] })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    transaction.close()
  }
}
const applied2 = await client.execute('SELECT version FROM schema_migrations WHERE version = 2')
if (!applied2.rows[0]) {
  const transaction = await client.transaction('write')
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    await transaction.execute({ sql: `INSERT INTO customer_status_history (customer_id, status, effective_date, reason, created_at)
      SELECT id, status, CASE WHEN status = 'inactive' THEN ? ELSE COALESCE(installation_date, substr(created_at, 1, 10), ?) END, 'Migration baseline', ?
      FROM customers WHERE NOT EXISTS (SELECT 1 FROM customer_status_history history WHERE history.customer_id = customers.id)`, args: [today, today, new Date().toISOString()] })
    await transaction.execute({ sql: `INSERT INTO customer_plan_history (customer_id, plan_id, plan_name_snapshot, price_paise_snapshot, effective_date, reason, created_at)
      SELECT customers.id, plans.id, plans.name, plans.price_paise, COALESCE(customers.installation_date, substr(customers.created_at, 1, 10), ?), 'Migration baseline', ?
      FROM customers JOIN plans ON plans.id = customers.plan_id
      WHERE NOT EXISTS (SELECT 1 FROM customer_plan_history history WHERE history.customer_id = customers.id)`, args: [today, new Date().toISOString()] })
    await transaction.execute(`UPDATE customers SET next_billing_start_date = CASE
      WHEN installation_date IS NULL THEN NULL
      WHEN (SELECT MAX(period_end) FROM invoices WHERE customer_id = customers.id AND is_deleted = 0 AND is_merged = 0) IS NULL THEN COALESCE(next_billing_start_date, installation_date)
      WHEN next_billing_start_date > date((SELECT MAX(period_end) FROM invoices WHERE customer_id = customers.id AND is_deleted = 0 AND is_merged = 0), '+1 day') THEN next_billing_start_date
      ELSE date((SELECT MAX(period_end) FROM invoices WHERE customer_id = customers.id AND is_deleted = 0 AND is_merged = 0), '+1 day') END`)
    await transaction.execute({ sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)', args: [new Date().toISOString()] })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    transaction.close()
  }
}
const applied3 = await client.execute('SELECT version FROM schema_migrations WHERE version = 3')
if (!applied3.rows[0]) {
  const transaction = await client.transaction('write')
  try {
    const orphanedOpeningDues = await transaction.execute(`SELECT invoice_charges.id AS chargeId, invoice_charges.amount_paise AS amountPaise,
      (SELECT live.id FROM invoices live WHERE live.customer_id = deleted.customer_id AND live.is_deleted = 0 AND live.is_merged = 0 ORDER BY live.period_start, live.id LIMIT 1) AS targetInvoiceId
      FROM invoice_charges JOIN invoices deleted ON deleted.id = invoice_charges.invoice_id
      WHERE invoice_charges.charge_type = 'opening_due' AND deleted.is_deleted = 1
      AND NOT EXISTS (SELECT 1 FROM invoices live JOIN invoice_charges live_charge ON live_charge.invoice_id = live.id
        WHERE live.customer_id = deleted.customer_id AND live.is_deleted = 0 AND live.is_merged = 0 AND live_charge.charge_type = 'opening_due')`)
    for (const row of orphanedOpeningDues.rows) {
      if (!row.targetInvoiceId) continue
      await transaction.execute({ sql: 'UPDATE invoice_charges SET invoice_id = ? WHERE id = ?', args: [row.targetInvoiceId, row.chargeId] })
      await transaction.execute({ sql: 'UPDATE invoices SET previous_due_snapshot_paise = ?, total_payable_paise = current_period_amount_paise + ? WHERE id = ?', args: [row.amountPaise, row.amountPaise, row.targetInvoiceId] })
    }
    await transaction.execute({ sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)', args: [new Date().toISOString()] })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    transaction.close()
  }
}
const applied4 = await client.execute('SELECT version FROM schema_migrations WHERE version = 4')
if (!applied4.rows[0]) {
  const transaction = await client.transaction('write')
  try {
    await transaction.execute(`CREATE TABLE IF NOT EXISTS payment_charge_allocations (
      id INTEGER PRIMARY KEY,
      payment_allocation_id INTEGER NOT NULL REFERENCES payment_allocations(id),
      invoice_charge_id INTEGER NOT NULL REFERENCES invoice_charges(id),
      amount_cash_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_cash_paise >= 0),
      amount_discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_discount_paise >= 0),
      amount_credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (amount_credit_paise >= 0),
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
      CHECK (amount_cash_paise + amount_discount_paise + amount_credit_paise > 0),
      UNIQUE (payment_allocation_id, invoice_charge_id)
    )`)
    const existing = await transaction.execute(`SELECT payment_allocations.id AS allocationId, payment_allocations.amount_cash_paise AS cashPaise,
      payment_allocations.amount_discount_paise AS discountPaise, payment_allocations.amount_credit_paise AS creditPaise,
      payment_allocations.invoice_id AS invoiceId
      FROM payment_allocations JOIN payments ON payments.id = payment_allocations.payment_id
      WHERE payment_allocations.is_deleted = 0 AND payments.is_deleted = 0`)
    for (const row of existing.rows) {
      const charges = await transaction.execute({ sql: `SELECT id, charge_type AS chargeType, amount_paise AS amountPaise
        FROM invoice_charges WHERE invoice_id = ? ORDER BY CASE charge_type WHEN 'opening_due' THEN 0 ELSE 1 END, id`, args: [row.invoiceId] })
      let cash = Number(row.cashPaise); let discount = Number(row.discountPaise); let credit = Number(row.creditPaise)
      for (const charge of charges.rows) {
        const remaining = Math.max(0, Number(charge.amountPaise))
        const chargeCash = Math.min(cash, remaining); cash -= chargeCash
        const chargeDiscount = Math.min(discount, Math.max(0, remaining - chargeCash)); discount -= chargeDiscount
        const chargeCredit = Math.min(credit, Math.max(0, remaining - chargeCash - chargeDiscount)); credit -= chargeCredit
        if (chargeCash + chargeDiscount + chargeCredit > 0) await transaction.execute({ sql: `INSERT OR IGNORE INTO payment_charge_allocations
          (payment_allocation_id, invoice_charge_id, amount_cash_paise, amount_discount_paise, amount_credit_paise) VALUES (?, ?, ?, ?, ?)`,
          args: [row.allocationId, charge.id, chargeCash, chargeDiscount, chargeCredit] })
      }
    }
    await transaction.execute({ sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)', args: [new Date().toISOString()] })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    transaction.close()
  }
}
const applied5 = await client.execute('SELECT version FROM schema_migrations WHERE version = 5')
if (!applied5.rows[0]) {
  const transaction = await client.transaction('write')
  try {
    await transaction.execute('CREATE INDEX IF NOT EXISTS customers_service_status_sort_index ON customers(service_type, is_deleted, status, sort_order)')
    await transaction.execute('CREATE INDEX IF NOT EXISTS invoices_list_filter_index ON invoices(service_type, is_deleted, is_merged, period_start, id)')
    await transaction.execute('CREATE INDEX IF NOT EXISTS invoices_customer_period_active_index ON invoices(customer_id, is_deleted, is_merged, period_start, period_end)')
    await transaction.execute('CREATE INDEX IF NOT EXISTS invoice_charges_invoice_type_index ON invoice_charges(invoice_id, charge_type)')
    await transaction.execute('CREATE INDEX IF NOT EXISTS payment_allocations_invoice_active_index ON payment_allocations(invoice_id, is_deleted)')
    await transaction.execute('CREATE INDEX IF NOT EXISTS payment_allocations_payment_active_index ON payment_allocations(payment_id, is_deleted)')
    await transaction.execute('CREATE INDEX IF NOT EXISTS payments_list_filter_index ON payments(service_type, is_deleted, payment_date, id)')
    await transaction.execute({ sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)', args: [new Date().toISOString()] })
    await transaction.commit()
  } catch (error) {
    await transaction.rollback()
    throw error
  } finally {
    transaction.close()
  }
}
await client.close()
console.log('Database schema applied successfully.')
