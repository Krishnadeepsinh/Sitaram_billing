import type { Transaction } from '@libsql/client'
import { addBillingDays, parseStrictDate, todayInBusinessTimezone } from '../../src/lib/date'
import { rebuildCustomerLedger } from './ledger'

export class InvoiceRequestError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function createInvoiceInTransaction(transaction: Transaction, input: { serviceType: 'cable' | 'broadband'; customerId: number; monthsBilled: number }) {
  const customer = await transaction.execute({ sql: `SELECT customers.*, areas.display_name AS area_name, plans.name AS plan_name, plans.price_paise, plans.is_active AS plan_is_active
    FROM customers JOIN areas ON areas.id = customers.area_id LEFT JOIN plans ON plans.id = customers.plan_id
    WHERE customers.id = ? AND customers.service_type = ? AND customers.is_deleted = 0`, args: [input.customerId, input.serviceType] })
  const row = customer.rows[0]
  if (!row || row.status !== 'active' || !row.plan_id || !row.next_billing_start_date || row.price_paise === null || Number(row.plan_is_active) !== 1) throw new InvoiceRequestError(400, 'Customer must be active and have an active plan and installation date before billing.')
  const periodStart = parseStrictDate(String(row.next_billing_start_date))
  const periodEnd = addBillingDays(periodStart, input.monthsBilled * 30 - 1)
  const overlap = await transaction.execute({ sql: 'SELECT id FROM invoices WHERE customer_id = ? AND is_deleted = 0 AND period_start <= ? AND period_end >= ? LIMIT 1', args: [input.customerId, periodEnd, periodStart] })
  if (overlap.rows[0]) throw new InvoiceRequestError(409, 'An invoice already covers this billing period.')
  const outstanding = await transaction.execute({ sql: `SELECT COALESCE(SUM(charges.total - COALESCE(allocations.settled, 0)), 0) AS due
    FROM invoices JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
    LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS settled FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocations ON allocations.invoice_id = invoices.id
    WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0`, args: [input.customerId] })
  const invoiceCount = await transaction.execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ? AND is_deleted = 0', args: [input.customerId] })
  const openingDue = Number(invoiceCount.rows[0].count) === 0 && row.opening_balance_type === 'due' ? Number(row.opening_balance_paise) : 0
  const serviceAmount = Number(row.price_paise) * input.monthsBilled
  const previousDue = Number(outstanding.rows[0].due) + openingDue
  const now = new Date().toISOString()
  const sequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['invoice', input.serviceType] })
  const invoiceCode = `INV-${String(sequence.rows[0].last_number).padStart(3, '0')}`
  const inserted = await transaction.execute({ sql: `INSERT INTO invoices (invoice_code, customer_id, service_type, customer_name_snapshot, area_name_snapshot, plan_name_snapshot, stb_number_snapshot, period_start, period_end, issued_date, months_billed, current_period_amount_paise, previous_due_snapshot_paise, total_payable_paise, due_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, args: [invoiceCode, input.customerId, input.serviceType, row.name, row.area_name, row.plan_name, row.stb_number, periodStart, periodEnd, todayInBusinessTimezone(), input.monthsBilled, serviceAmount, previousDue, serviceAmount + previousDue, addBillingDays(periodEnd, 7), now] })
  const invoiceId = Number(inserted.rows[0].id)
  await transaction.execute({ sql: "INSERT INTO invoice_charges (invoice_id, charge_type, description, amount_paise) VALUES (?, 'service', ?, ?)", args: [invoiceId, `${row.plan_name} service charge`, serviceAmount] })
  if (openingDue) await transaction.execute({ sql: "INSERT INTO invoice_charges (invoice_id, charge_type, description, amount_paise) VALUES (?, 'opening_due', 'Opening balance due', ?)", args: [invoiceId, openingDue] })
  await transaction.execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [addBillingDays(periodEnd, 1), input.customerId] })
  const totalDebt = previousDue + serviceAmount
  if (Number(row.credit_balance_paise) >= totalDebt && totalDebt > 0) {
    const paymentSequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['payment', input.serviceType] })
    const paymentCode = `PAY-${String(paymentSequence.rows[0].last_number).padStart(3, '0')}`
    await transaction.execute({ sql: `INSERT INTO payments (payment_code, customer_id, service_type, payment_date, amount_received_paise, discount_given_paise, payment_mode, notes, resulting_status, created_at)
      VALUES (?, ?, ?, ?, 0, 0, 'system_credit', 'Automatic credit application', 'settled', ?)`, args: [paymentCode, input.customerId, input.serviceType, todayInBusinessTimezone(), now] })
    await rebuildCustomerLedger(transaction, input.customerId)
  }
  return { invoiceId, invoiceCode, periodStart, periodEnd }
}
