import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'
import { createInvoiceInTransaction, InvoiceRequestError } from '../_lib/invoice-service'
import { rebuildCustomerLedger } from '../_lib/ledger'

const inputSchema = z.object({ serviceType: serviceTypeSchema, customerId: z.number().int().positive(), monthsBilled: z.number().int().min(1).max(24) })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const db = database()
      if (request.query.id) {
        const invoiceId = z.coerce.number().int().positive().parse(request.query.id)
        const invoice = await db.execute({ sql: `SELECT invoices.id, invoices.invoice_code AS invoiceCode, invoices.customer_id AS customerId, customers.customer_code AS customerCode,
          invoices.customer_name_snapshot AS customerName, invoices.area_name_snapshot AS areaName, invoices.plan_name_snapshot AS planName, invoices.stb_number_snapshot AS stbNumber,
          invoices.period_start AS periodStart, invoices.period_end AS periodEnd, invoices.issued_date AS issuedDate, invoices.months_billed AS monthsBilled,
          invoices.current_period_amount_paise AS currentPeriodAmountPaise, invoices.previous_due_snapshot_paise AS previousDueSnapshotPaise,
          invoices.total_payable_paise AS totalPayablePaise, invoices.due_date AS dueDate, invoices.status
          FROM invoices JOIN customers ON customers.id = invoices.customer_id WHERE invoices.id = ? AND invoices.service_type = ? AND invoices.is_deleted = 0`, args: [invoiceId, serviceType] })
        if (!invoice.rows[0]) return sendError(response, 404, 'Invoice not found.')
        const [charges, allocations, mergeItems] = await Promise.all([
          db.execute({ sql: 'SELECT charge_type AS chargeType, description, amount_paise AS amountPaise FROM invoice_charges WHERE invoice_id = ? ORDER BY id', args: [invoiceId] }),
          db.execute({ sql: `SELECT payments.payment_code AS paymentCode, payments.payment_date AS paymentDate, payment_allocations.amount_cash_paise AS cashPaise, payment_allocations.amount_discount_paise AS discountPaise, payment_allocations.amount_credit_paise AS creditPaise FROM payment_allocations JOIN payments ON payments.id = payment_allocations.payment_id WHERE payment_allocations.invoice_id = ? AND payment_allocations.is_deleted = 0 AND payments.is_deleted = 0 ORDER BY payments.payment_date, payments.id`, args: [invoiceId] }),
          db.execute({ sql: `SELECT source.invoice_code AS invoiceCode, source.plan_name_snapshot AS planName, source.period_start AS periodStart, source.period_end AS periodEnd, source.current_period_amount_paise AS amountPaise FROM invoice_merge_items JOIN invoices source ON source.id = invoice_merge_items.source_invoice_id WHERE invoice_merge_items.merged_invoice_id = ? ORDER BY invoice_merge_items.sort_order`, args: [invoiceId] }),
        ])
        const liveBalance = charges.rows.reduce((sum, row) => sum + Number(row.amountPaise), 0) - allocations.rows.reduce((sum, row) => sum + Number(row.cashPaise) + Number(row.discountPaise) + Number(row.creditPaise), 0)
        return response.status(200).json({ ...invoice.rows[0], liveBalancePaise: liveBalance, charges: charges.rows, allocations: allocations.rows, mergeItems: mergeItems.rows })
      }
      const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%'
      const showMerged = request.query.showMerged === '1' ? 1 : 0
      const result = await db.execute({ sql: `SELECT invoices.id, invoices.invoice_code AS invoiceCode, invoices.customer_id AS customerId,
        invoices.customer_name_snapshot AS customerName, invoices.period_start AS periodStart, invoices.period_end AS periodEnd,
        invoices.issued_date AS issuedDate, invoices.total_payable_paise AS totalPayablePaise, invoices.status, invoices.due_date AS dueDate, invoices.is_merged AS isMerged,
        charges.total - COALESCE(allocations.total, 0) AS balancePaise
        FROM invoices
        JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
        LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocations ON allocations.invoice_id = invoices.id
        WHERE invoices.service_type = ? AND invoices.is_deleted = 0 AND (? = 1 OR invoices.is_merged = 0)
        AND (invoices.invoice_code LIKE ? OR invoices.customer_name_snapshot LIKE ? OR COALESCE(invoices.stb_number_snapshot, '') LIKE ?)
        ORDER BY invoices.period_start DESC, invoices.id DESC LIMIT 200`, args: [serviceType, showMerged, query, query, query] })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'DELETE') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const invoiceId = z.coerce.number().int().positive().parse(request.query.id)
      const transaction = await database().transaction('write')
      try {
        const invoice = await transaction.execute({ sql: `SELECT id, customer_id, period_start FROM invoices WHERE id = ? AND service_type = ? AND is_deleted = 0`, args: [invoiceId, serviceType] })
        if (!invoice.rows[0]) { await transaction.rollback(); return sendError(response, 404, 'Invoice not found.') }
        const later = await transaction.execute({ sql: 'SELECT id FROM invoices WHERE customer_id = ? AND is_deleted = 0 AND is_merged = 0 AND (period_start > ? OR (period_start = ? AND id > ?)) LIMIT 1', args: [invoice.rows[0].customer_id, invoice.rows[0].period_start, invoice.rows[0].period_start, invoiceId] })
        if (later.rows[0]) { await transaction.rollback(); return sendError(response, 409, 'Only the latest invoice can be deleted.') }
        const linkedPayments = await transaction.execute({ sql: `SELECT DISTINCT payments.id FROM payment_allocations
          JOIN payments ON payments.id = payment_allocations.payment_id
          WHERE payment_allocations.invoice_id = ? AND payment_allocations.is_deleted = 0 AND payments.is_deleted = 0`, args: [invoiceId] })
        const paymentIds = linkedPayments.rows.map((row) => Number(row.id))
        if (paymentIds.length) {
          const placeholders = paymentIds.map(() => '?').join(',')
          await transaction.execute({ sql: `UPDATE payments SET is_deleted = 1 WHERE id IN (${placeholders})`, args: paymentIds })
          await transaction.execute({ sql: `UPDATE payment_allocations SET is_deleted = 1 WHERE payment_id IN (${placeholders})`, args: paymentIds })
        }
        await transaction.execute({ sql: 'UPDATE invoices SET is_deleted = 1 WHERE id = ?', args: [invoiceId] })
        await transaction.execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [invoice.rows[0].period_start, invoice.rows[0].customer_id] })
        await rebuildCustomerLedger(transaction, Number(invoice.rows[0].customer_id))
        await transaction.commit()
        return response.status(204).end()
      } catch (error) {
        await transaction.rollback()
        throw error
      }
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'DELETE'])
    const input = body(inputSchema, request.body)
    const transaction = await database().transaction('write')
    try {
      const result = await createInvoiceInTransaction(transaction, input)
      await transaction.commit()
      return response.status(201).json(result)
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide a valid customer and month count.')
    if (error instanceof InvoiceRequestError) return sendError(response, error.status, error.message)
    console.error('Invoice generation failed', error)
    return sendError(response, 500, 'Unable to generate invoice.')
  }
}
