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
await client.close()
console.log('Database schema applied successfully.')
