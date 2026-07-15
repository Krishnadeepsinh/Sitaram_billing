import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { parseStrictDate } from '../../src/lib/date'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'
import { rebuildCustomerLedger } from '../_lib/ledger'

const paymentSchema = z.object({ serviceType: serviceTypeSchema, customerId: z.number().int().positive(), paymentDate: z.string().min(1), amountReceivedPaise: z.number().int().positive(), discountGivenPaise: z.number().int().nonnegative().default(0), paymentMode: z.enum(['cash', 'upi']), notes: z.string().trim().max(500).optional() })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const db = database()
      if (request.query.id) {
        const id = z.coerce.number().int().positive().parse(request.query.id)
        const payment = await db.execute({ sql: `SELECT payments.id, payments.payment_code AS paymentCode, payments.customer_id AS customerId, customers.customer_code AS customerCode,
          customers.name AS customerName, customers.stb_number AS stbNumber, areas.display_name AS areaName, payments.payment_date AS paymentDate,
          payments.amount_received_paise AS amountReceivedPaise, payments.discount_given_paise AS discountGivenPaise, payments.payment_mode AS paymentMode,
          payments.notes, payments.resulting_status AS resultingStatus FROM payments JOIN customers ON customers.id = payments.customer_id JOIN areas ON areas.id = customers.area_id
          WHERE payments.id = ? AND payments.service_type = ? AND payments.is_deleted = 0`, args: [id, serviceType] })
        if (!payment.rows[0]) return sendError(response, 404, 'Payment not found.')
        const allocations = await db.execute({ sql: `SELECT invoices.invoice_code AS invoiceCode, invoices.period_start AS periodStart, invoices.period_end AS periodEnd,
          payment_allocations.amount_cash_paise AS cashPaise, payment_allocations.amount_discount_paise AS discountPaise, payment_allocations.amount_credit_paise AS creditPaise
          FROM payment_allocations JOIN invoices ON invoices.id = payment_allocations.invoice_id WHERE payment_allocations.payment_id = ? AND payment_allocations.is_deleted = 0 ORDER BY invoices.period_start`, args: [id] })
        return response.status(200).json({ ...payment.rows[0], allocations: allocations.rows })
      }
      const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%'
      const from = typeof request.query.from === 'string' && request.query.from ? parseStrictDate(request.query.from) : '0000-01-01'
      const to = typeof request.query.to === 'string' && request.query.to ? parseStrictDate(request.query.to) : '9999-12-31'
      const mode = request.query.mode === 'cash' || request.query.mode === 'upi' || request.query.mode === 'system_credit' ? request.query.mode : null
      const result = await db.execute({ sql: `SELECT payments.id, payments.payment_code AS paymentCode, payments.customer_id AS customerId,
        customers.name AS customerName, payments.payment_date AS paymentDate, payments.amount_received_paise AS amountReceivedPaise,
        payments.discount_given_paise AS discountGivenPaise, payments.payment_mode AS paymentMode, payments.resulting_status AS resultingStatus, payments.notes
        FROM payments JOIN customers ON customers.id = payments.customer_id
        WHERE payments.service_type = ? AND payments.is_deleted = 0
        AND payments.payment_date BETWEEN ? AND ? AND (? IS NULL OR payments.payment_mode = ?)
        AND (payments.payment_code LIKE ? OR customers.name LIKE ? OR customers.customer_code LIKE ?)
        ORDER BY payments.payment_date DESC, payments.id DESC LIMIT 200`, args: [serviceType, from, to, mode, mode, query, query, query] })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'DELETE') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const paymentId = z.coerce.number().int().positive().parse(request.query.id)
      const transaction = await database().transaction('write')
      try {
        const payment = await transaction.execute({ sql: 'SELECT customer_id FROM payments WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [paymentId, serviceType] })
        if (!payment.rows[0]) { await transaction.rollback(); return sendError(response, 404, 'Payment not found.') }
        const customerId = Number(payment.rows[0].customer_id)
        await transaction.execute({ sql: 'UPDATE payments SET is_deleted = 1 WHERE id = ?', args: [paymentId] })
        await transaction.execute({ sql: 'UPDATE payment_allocations SET is_deleted = 1 WHERE payment_id = ?', args: [paymentId] })
        await rebuildCustomerLedger(transaction, customerId)
        await transaction.commit()
        return response.status(204).end()
      } catch (error) {
        await transaction.rollback()
        return sendError(response, 409, error instanceof Error && error.message.includes('Discount cannot') ? 'This payment cannot be reversed because a later discount would become invalid. Reverse later payments first.' : 'Unable to reverse payment safely.')
      }
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'DELETE'])
    const input = body(paymentSchema, request.body)
    const paymentDate = parseStrictDate(input.paymentDate)
    const now = new Date().toISOString()
    const transaction = await database().transaction('write')
    try {
      const customer = await transaction.execute({ sql: 'SELECT credit_balance_paise FROM customers WHERE id = ? AND service_type = ?', args: [input.customerId, input.serviceType] })
      if (!customer.rows[0]) { await transaction.rollback(); return sendError(response, 404, 'Customer not found.') }
      const due = await transaction.execute({ sql: `SELECT COALESCE(SUM(charges.total - COALESCE(allocated.total, 0)), 0) AS value FROM invoices
        JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
        LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocated ON allocated.invoice_id = invoices.id
        WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0`, args: [input.customerId] })
      const maxDiscount = Math.max(0, Number(due.rows[0].value) - input.amountReceivedPaise - Number(customer.rows[0].credit_balance_paise))
      if (input.discountGivenPaise > maxDiscount) { await transaction.rollback(); return sendError(response, 400, 'Discount cannot create advance credit.') }
      const sequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['payment', input.serviceType] })
      const paymentCode = `PAY-${String(sequence.rows[0].last_number).padStart(3, '0')}`
      const payment = await transaction.execute({ sql: `INSERT INTO payments (payment_code, customer_id, service_type, payment_date, amount_received_paise, discount_given_paise, payment_mode, notes, resulting_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?) RETURNING id`, args: [paymentCode, input.customerId, input.serviceType, paymentDate, input.amountReceivedPaise, input.discountGivenPaise, input.paymentMode, input.notes ?? null, now] })
      const replay = await rebuildCustomerLedger(transaction, input.customerId)
      await transaction.commit()
      const paymentId = Number(payment.rows[0].id)
      return response.status(201).json({ paymentCode, resultingStatus: replay.paymentStatuses.find((item) => item.paymentId === paymentId)?.status, allocations: replay.allocations.filter((item) => item.paymentId === paymentId) })
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide valid payment details.')
    console.error('Payment recording failed', error)
    return sendError(response, 500, 'Unable to record payment.')
  }
}
