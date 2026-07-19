import { readFile } from 'node:fs/promises'

const file = process.argv[2]
if (!file) throw new Error('Usage: pnpm validate:backup <backup.json>')
const backup = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
const baseTables = ['business_settings', 'areas', 'plans', 'customers', 'invoices', 'invoice_charges', 'invoice_merge_items', 'payments', 'payment_allocations', 'expenses', 'id_sequences']

if (![1, 2, 3].includes(backup.version) || !backup.exportedAt || !backup.data) throw new Error('Backup envelope is invalid or unsupported.')
const requiredTables = backup.version >= 3 ? [...baseTables, 'customer_status_history', 'customer_plan_history', 'customer_plan_gaps', 'audit_events'] : baseTables
for (const table of requiredTables) if (!Array.isArray(backup.data[table])) throw new Error(`Backup table ${table} is missing or invalid.`)
if (['admin_auth', 'admin_sessions', 'login_attempts'].some((table) => table in backup.data)) throw new Error('Backup contains authentication data and is unsafe to retain.')

const ids = (table) => new Set(backup.data[table].map((row) => Number(row.id)))
const customers = ids('customers'); const invoices = ids('invoices'); const payments = ids('payments')
const requireFields = (table, fields) => backup.data[table].forEach((row, index) => {
  if (!row || typeof row !== 'object' || fields.some((field) => row[field] === undefined || row[field] === null)) throw new Error(`${table}[${index}] is missing required fields.`)
})
requireFields('customers', ['id', 'customer_code', 'service_type', 'name', 'area_id'])
requireFields('invoices', ['id', 'invoice_code', 'customer_id', 'service_type', 'period_start', 'period_end'])
requireFields('payments', ['id', 'payment_code', 'customer_id', 'service_type', 'payment_date'])
for (const row of backup.data.invoices) if (!customers.has(Number(row.customer_id))) throw new Error(`Invoice ${row.id} references a missing customer.`)
for (const row of backup.data.payments) if (!customers.has(Number(row.customer_id))) throw new Error(`Payment ${row.id} references a missing customer.`)
for (const row of backup.data.invoice_charges) if (!invoices.has(Number(row.invoice_id))) throw new Error(`Invoice charge ${row.id} references a missing invoice.`)
for (const row of backup.data.payment_allocations) {
  if (!payments.has(Number(row.payment_id)) || !invoices.has(Number(row.invoice_id))) throw new Error(`Payment allocation ${row.id} has a broken reference.`)
}

console.log(`Backup is valid: ${requiredTables.length} tables, ${backup.data.customers.length} customers, ${backup.data.invoices.length} invoices, ${backup.data.payments.length} payments.`)
