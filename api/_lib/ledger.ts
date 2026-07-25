import type { Transaction } from '@libsql/client'
import { replayLedger } from '../../src/lib/replay'
import { withWriteTransaction } from './db'

export async function rebuildCustomerLedger(transaction: Transaction, customerId: number) {
  const customer = await transaction.execute({ sql: 'SELECT opening_balance_paise, opening_balance_type FROM customers WHERE id = ?', args: [customerId] })
  if (!customer.rows[0]) throw new Error('Customer not found.')

  const invoiceResult = await transaction.execute({ sql: `SELECT invoices.id, invoices.period_start AS periodStart, invoices.created_at AS createdAt, COALESCE(SUM(invoice_charges.amount_paise), 0) AS amountPaise
      FROM invoices JOIN invoice_charges ON invoice_charges.invoice_id = invoices.id
      WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0
      GROUP BY invoices.id ORDER BY invoices.period_start, invoices.id`, args: [customerId] })
  const chargeResult = await transaction.execute({ sql: `SELECT invoice_id AS invoiceId, id, charge_type AS chargeType, amount_paise AS amountPaise
    FROM invoice_charges WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ? AND is_deleted = 0 AND is_merged = 0)
    ORDER BY invoice_id, CASE charge_type WHEN 'opening_due' THEN 0 ELSE 1 END, id`, args: [customerId] })
  const paymentResult = await transaction.execute({ sql: `SELECT id, amount_received_paise AS amountReceivedPaise, discount_given_paise AS discountGivenPaise, payment_mode AS paymentMode, created_at AS createdAt
      FROM payments WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at, id`, args: [customerId] })
  const chargesByInvoice = new Map<number, Array<{ id: number; chargeType: 'opening_due' | 'service'; amountPaise: number }>>()
  for (const row of chargeResult.rows) {
    const invoiceId = Number(row.invoiceId)
    const charges = chargesByInvoice.get(invoiceId) ?? []
    charges.push({ id: Number(row.id), chargeType: String(row.chargeType) as 'opening_due' | 'service', amountPaise: Number(row.amountPaise) })
    chargesByInvoice.set(invoiceId, charges)
  }
  const invoices = invoiceResult.rows.map((row) => ({ id: Number(row.id), periodStart: String(row.periodStart), amountPaise: Number(row.amountPaise), charges: chargesByInvoice.get(Number(row.id)) ?? [], createdAt: String(row.createdAt) }))
  const payments = paymentResult.rows.map((row) => ({ id: Number(row.id), amountReceivedPaise: Number(row.amountReceivedPaise), discountGivenPaise: Number(row.discountGivenPaise), paymentMode: String(row.paymentMode) as 'cash' | 'upi' | 'system_credit', createdAt: String(row.createdAt) }))
  const openingCredit = customer.rows[0].opening_balance_type === 'advance' ? Number(customer.rows[0].opening_balance_paise) : 0
  const replay = replayLedger(openingCredit, invoices, payments)

  const paymentIds = payments.map((payment) => payment.id)
  if (paymentIds.length) {
    await transaction.execute({ sql: `UPDATE payment_charge_allocations SET is_deleted = 1 WHERE payment_allocation_id IN (SELECT id FROM payment_allocations WHERE payment_id IN (${paymentIds.map(() => '?').join(',')}))`, args: paymentIds })
    await transaction.execute({ sql: `UPDATE payment_allocations SET is_deleted = 1 WHERE payment_id IN (${paymentIds.map(() => '?').join(',')}) AND is_deleted = 0`, args: paymentIds })
  }
  for (const allocation of replay.allocations) {
    const inserted = await transaction.execute({ sql: `INSERT INTO payment_allocations (payment_id, invoice_id, amount_cash_paise, amount_discount_paise, amount_credit_paise)
      VALUES (?, ?, ?, ?, ?) RETURNING id`, args: [allocation.paymentId, allocation.invoiceId, allocation.cashPaise, allocation.discountPaise, allocation.creditPaise] })
    for (const charge of allocation.chargeAllocations ?? []) {
      if (charge.cashPaise + charge.discountPaise + charge.creditPaise > 0) await transaction.execute({ sql: `INSERT INTO payment_charge_allocations
        (payment_allocation_id, invoice_charge_id, amount_cash_paise, amount_discount_paise, amount_credit_paise) VALUES (?, ?, ?, ?, ?)`,
        args: [inserted.rows[0].id, charge.chargeId, charge.cashPaise, charge.discountPaise, charge.creditPaise] })
    }
  }
  for (const invoice of replay.invoiceStatuses) await transaction.execute({ sql: 'UPDATE invoices SET status = ? WHERE id = ?', args: [invoice.status, invoice.invoiceId] })
  for (const payment of replay.paymentStatuses) await transaction.execute({ sql: 'UPDATE payments SET resulting_status = ? WHERE id = ?', args: [payment.status, payment.paymentId] })
  await transaction.execute({ sql: 'UPDATE customers SET credit_balance_paise = ? WHERE id = ?', args: [replay.creditPaise, customerId] })
  return replay
}

export async function refreshCustomerLedger(customerId: number) {
  return withWriteTransaction((transaction) => rebuildCustomerLedger(transaction, customerId))
}
