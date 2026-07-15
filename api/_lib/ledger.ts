import type { Transaction } from '@libsql/client'
import { replayLedger } from '../../src/lib/replay'
import { database } from './db'

export async function rebuildCustomerLedger(transaction: Transaction, customerId: number) {
  const customer = await transaction.execute({ sql: 'SELECT opening_balance_paise, opening_balance_type FROM customers WHERE id = ?', args: [customerId] })
  if (!customer.rows[0]) throw new Error('Customer not found.')

  const invoiceResult = await transaction.execute({ sql: `SELECT invoices.id, invoices.period_start AS periodStart, COALESCE(SUM(invoice_charges.amount_paise), 0) AS amountPaise
      FROM invoices JOIN invoice_charges ON invoice_charges.invoice_id = invoices.id
      WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0
      GROUP BY invoices.id ORDER BY invoices.period_start, invoices.id`, args: [customerId] })
  const paymentResult = await transaction.execute({ sql: `SELECT id, amount_received_paise AS amountReceivedPaise, discount_given_paise AS discountGivenPaise, payment_mode AS paymentMode
      FROM payments WHERE customer_id = ? AND is_deleted = 0 ORDER BY created_at, id`, args: [customerId] })
  const invoices = invoiceResult.rows.map((row) => ({ id: Number(row.id), periodStart: String(row.periodStart), amountPaise: Number(row.amountPaise) }))
  const payments = paymentResult.rows.map((row) => ({ id: Number(row.id), amountReceivedPaise: Number(row.amountReceivedPaise), discountGivenPaise: Number(row.discountGivenPaise), paymentMode: String(row.paymentMode) as 'cash' | 'upi' | 'system_credit' }))
  const openingCredit = customer.rows[0].opening_balance_type === 'advance' ? Number(customer.rows[0].opening_balance_paise) : 0
  const replay = replayLedger(openingCredit, invoices, payments)

  const paymentIds = payments.map((payment) => payment.id)
  if (paymentIds.length) await transaction.execute({ sql: `UPDATE payment_allocations SET is_deleted = 1 WHERE payment_id IN (${paymentIds.map(() => '?').join(',')}) AND is_deleted = 0`, args: paymentIds })
  for (const allocation of replay.allocations) {
    await transaction.execute({ sql: `INSERT INTO payment_allocations (payment_id, invoice_id, amount_cash_paise, amount_discount_paise, amount_credit_paise)
      VALUES (?, ?, ?, ?, ?)`, args: [allocation.paymentId, allocation.invoiceId, allocation.cashPaise, allocation.discountPaise, allocation.creditPaise] })
  }
  for (const invoice of replay.invoiceStatuses) await transaction.execute({ sql: 'UPDATE invoices SET status = ? WHERE id = ?', args: [invoice.status, invoice.invoiceId] })
  for (const payment of replay.paymentStatuses) await transaction.execute({ sql: 'UPDATE payments SET resulting_status = ? WHERE id = ?', args: [payment.status, payment.paymentId] })
  await transaction.execute({ sql: 'UPDATE customers SET credit_balance_paise = ? WHERE id = ?', args: [replay.creditPaise, customerId] })
  return replay
}

export async function refreshCustomerLedger(customerId: number) {
  const transaction = await database().transaction('write')
  try {
    const result = await rebuildCustomerLedger(transaction, customerId)
    await transaction.commit()
    return result
  } catch (error) {
    await transaction.rollback()
    throw error
  }
}
