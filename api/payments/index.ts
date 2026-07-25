import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { MAX_MONEY_PAISE } from '../../src/lib/billing'
import { DateInputError, parseStrictDate, todayInBusinessTimezone } from '../../src/lib/date'
import { recordAudit } from '../_lib/audit'
import { database, withWriteTransaction } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'
import { rebuildCustomerLedger } from '../_lib/ledger'

const paymentSchema = z.object({ serviceType: serviceTypeSchema, customerId: z.number().int().positive(), paymentDate: z.string().min(1), amountReceivedPaise: z.number().int().nonnegative().max(MAX_MONEY_PAISE), discountGivenPaise: z.number().int().nonnegative().max(MAX_MONEY_PAISE).default(0), paymentMode: z.enum(['cash', 'upi']), notes: z.string().trim().max(500).optional(), requestKey: z.string().trim().min(8).max(100) })
  .refine((value) => value.amountReceivedPaise + value.discountGivenPaise > 0, { message: 'Enter an amount received or a discount.' })
class PaymentRequestError extends Error { constructor(public status: number, message: string) { super(message) } }

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const db = database()
      if (request.query.deletePreview) {
        const id = z.coerce.number().int().positive().parse(request.query.deletePreview)
        const payment = await db.execute({ sql: `SELECT payments.payment_code AS paymentCode, payments.customer_id AS customerId, payments.amount_received_paise AS amountReceivedPaise,
          payments.discount_given_paise AS discountGivenPaise, customers.credit_balance_paise AS currentCreditPaise
          FROM payments JOIN customers ON customers.id = payments.customer_id WHERE payments.id = ? AND payments.service_type = ? AND payments.is_deleted = 0`, args: [id, serviceType] })
        if (!payment.rows[0]) return sendError(response, 404, 'Payment not found.')
        const invoices = await db.execute({ sql: `SELECT invoices.invoice_code AS invoiceCode, invoices.status,
          payment_allocations.amount_cash_paise + payment_allocations.amount_discount_paise + payment_allocations.amount_credit_paise AS allocatedPaise
          FROM payment_allocations JOIN invoices ON invoices.id = payment_allocations.invoice_id
          WHERE payment_allocations.payment_id = ? AND payment_allocations.is_deleted = 0 ORDER BY invoices.period_start`, args: [id] })
        return response.status(200).json({ ...payment.rows[0], invoices: invoices.rows })
      }
      if (request.query.id) {
        const id = z.coerce.number().int().positive().parse(request.query.id)
        const payment = await db.execute({ sql: `SELECT payments.id, payments.payment_code AS paymentCode, payments.customer_id AS customerId, payments.customer_code_snapshot AS customerCode,
          payments.customer_name_snapshot AS customerName, customers.phone, payments.service_type AS serviceType, payments.stb_number_snapshot AS stbNumber, payments.area_name_snapshot AS areaName, payments.payment_date AS paymentDate,
          payments.amount_received_paise AS amountReceivedPaise, payments.discount_given_paise AS discountGivenPaise, payments.payment_mode AS paymentMode,
          payments.notes, payments.resulting_status AS resultingStatus,
          CASE WHEN payments.payment_mode = 'system_credit' THEN COALESCE((SELECT SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) FROM payment_allocations WHERE payment_id = payments.id AND is_deleted = 0), 0)
            ELSE payments.amount_received_paise + payments.discount_given_paise END AS settledAmountPaise,
          (SELECT COALESCE(SUM(charges.total - COALESCE(allocated.total, 0)), 0) FROM invoices
            JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
            LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocated ON allocated.invoice_id = invoices.id
            WHERE invoices.customer_id = payments.customer_id AND invoices.is_deleted = 0 AND invoices.is_merged = 0) AS liveBalancePaise
          FROM payments JOIN customers ON customers.id = payments.customer_id
          WHERE payments.id = ? AND payments.service_type = ? AND payments.is_deleted = 0`, args: [id, serviceType] })
        if (!payment.rows[0]) return sendError(response, 404, 'Payment not found.')
        const allocations = await db.execute({ sql: `SELECT invoices.invoice_code AS invoiceCode, invoices.period_start AS periodStart, invoices.period_end AS periodEnd,
          invoice_charges.charge_type AS chargeType,
          COALESCE(payment_charge_allocations.amount_cash_paise, payment_allocations.amount_cash_paise) AS cashPaise,
          COALESCE(payment_charge_allocations.amount_discount_paise, payment_allocations.amount_discount_paise) AS discountPaise,
          COALESCE(payment_charge_allocations.amount_credit_paise, payment_allocations.amount_credit_paise) AS creditPaise
          FROM payment_allocations JOIN invoices ON invoices.id = payment_allocations.invoice_id
          LEFT JOIN payment_charge_allocations ON payment_charge_allocations.payment_allocation_id = payment_allocations.id AND payment_charge_allocations.is_deleted = 0
          LEFT JOIN invoice_charges ON invoice_charges.id = payment_charge_allocations.invoice_charge_id
          WHERE payment_allocations.payment_id = ? AND payment_allocations.is_deleted = 0 ORDER BY invoices.period_start, invoice_charges.id`, args: [id] })
        return response.status(200).json({ ...payment.rows[0], allocations: allocations.rows })
      }
      const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%'
      const from = typeof request.query.from === 'string' && request.query.from ? parseStrictDate(request.query.from) : '0000-01-01'
      const to = typeof request.query.to === 'string' && request.query.to ? parseStrictDate(request.query.to) : '9999-12-31'
      if (from > to) return sendError(response, 400, 'The From date must be on or before the To date.')
      const mode = request.query.mode === 'cash' || request.query.mode === 'upi' || request.query.mode === 'system_credit' ? request.query.mode : null
      const limit = request.query.limit ? z.coerce.number().int().min(1).max(200).parse(request.query.limit) : 100
      const offset = request.query.offset ? z.coerce.number().int().nonnegative().parse(request.query.offset) : 0
      const result = await db.execute({ sql: `SELECT payments.id, payments.payment_code AS paymentCode, payments.customer_id AS customerId,
        payments.customer_name_snapshot AS customerName, payments.payment_date AS paymentDate, payments.amount_received_paise AS amountReceivedPaise,
        payments.discount_given_paise AS discountGivenPaise, payments.payment_mode AS paymentMode, payments.resulting_status AS resultingStatus, payments.notes,
        CASE WHEN payments.payment_mode = 'system_credit' THEN COALESCE((SELECT SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) FROM payment_allocations WHERE payment_id = payments.id AND is_deleted = 0), 0)
          ELSE payments.amount_received_paise + payments.discount_given_paise END AS settledAmountPaise,
        COALESCE((SELECT json_group_array(json_object('invoiceCode', invoices.invoice_code, 'periodStart', invoices.period_start, 'periodEnd', invoices.period_end, 'chargeType', invoice_charges.charge_type,
          'cashPaise', payment_charge_allocations.amount_cash_paise, 'discountPaise', payment_charge_allocations.amount_discount_paise, 'creditPaise', payment_charge_allocations.amount_credit_paise))
          FROM payment_charge_allocations JOIN payment_allocations ON payment_allocations.id = payment_charge_allocations.payment_allocation_id
          JOIN invoices ON invoices.id = payment_allocations.invoice_id JOIN invoice_charges ON invoice_charges.id = payment_charge_allocations.invoice_charge_id
          WHERE payment_allocations.payment_id = payments.id AND payment_charge_allocations.is_deleted = 0), '[]') AS allocationsJson
        FROM payments JOIN customers ON customers.id = payments.customer_id
        WHERE payments.service_type = ? AND payments.is_deleted = 0
        AND payments.payment_date BETWEEN ? AND ? AND (? IS NULL OR payments.payment_mode = ?)
        AND (payments.payment_code LIKE ? OR payments.customer_name_snapshot LIKE ? OR payments.customer_code_snapshot LIKE ? OR COALESCE(payments.stb_number_snapshot, '') LIKE ?)
        ORDER BY payments.payment_date DESC, payments.id DESC LIMIT ? OFFSET ?`, args: [serviceType, from, to, mode, mode, query, query, query, query, limit, offset] })
      const count = await db.execute({ sql: `SELECT COUNT(*) AS value FROM payments WHERE service_type = ? AND is_deleted = 0 AND payment_date BETWEEN ? AND ? AND (? IS NULL OR payment_mode = ?) AND (payment_code LIKE ? OR customer_name_snapshot LIKE ? OR customer_code_snapshot LIKE ? OR COALESCE(stb_number_snapshot, '') LIKE ?)`, args: [serviceType, from, to, mode, mode, query, query, query, query] })
      const items = result.rows.map((row) => ({ ...row, allocations: JSON.parse(String(row.allocationsJson || '[]')) }))
      return response.status(200).json({ items, total: Number(count.rows[0].value), limit, offset })
    }
    if (request.method === 'DELETE') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const paymentId = z.coerce.number().int().positive().parse(request.query.id)
      const reason = typeof request.query.reason === 'string' && request.query.reason.trim().length >= 5 ? request.query.reason.trim().slice(0, 250) : 'Reversed by administrator'
      try {
        await withWriteTransaction(async (transaction) => {
          const payment = await transaction.execute({ sql: 'SELECT customer_id FROM payments WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [paymentId, serviceType] })
          if (!payment.rows[0]) throw new PaymentRequestError(404, 'Payment not found.')
          const customerId = Number(payment.rows[0].customer_id)
          await transaction.execute({ sql: 'UPDATE payments SET is_deleted = 1 WHERE id = ?', args: [paymentId] })
          await transaction.execute({ sql: 'UPDATE payment_allocations SET is_deleted = 1 WHERE payment_id = ?', args: [paymentId] })
          await rebuildCustomerLedger(transaction, customerId)
          await recordAudit(transaction, { entityType: 'payment', entityId: paymentId, action: 'payment_reversed', reason })
        })
        return response.status(204).end()
      } catch (error) {
        if (error instanceof PaymentRequestError) return sendError(response, error.status, error.message)
        return sendError(response, 409, error instanceof Error && error.message.includes('Discount cannot') ? 'This payment cannot be reversed because a later discount would become invalid. Reverse later payments first.' : 'Unable to reverse payment safely.')
      }
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'DELETE'])
    const input = body(paymentSchema, request.body)
    const paymentDate = parseStrictDate(input.paymentDate)
    if (paymentDate > todayInBusinessTimezone()) throw new PaymentRequestError(400, 'Payment date cannot be in the future.')
    const now = new Date().toISOString()
    const result = await withWriteTransaction(async (transaction) => {
      const existing = await transaction.execute({ sql: `SELECT payment_code AS paymentCode, resulting_status AS resultingStatus, customer_id AS customerId,
        payment_date AS paymentDate, amount_received_paise AS amountReceivedPaise, discount_given_paise AS discountGivenPaise,
        payment_mode AS paymentMode, COALESCE(notes, '') AS notes FROM payments WHERE service_type = ? AND request_key = ? LIMIT 1`, args: [input.serviceType, input.requestKey] })
      if (existing.rows[0]) {
        const sameRequest = Number(existing.rows[0].customerId) === input.customerId
          && String(existing.rows[0].paymentDate) === paymentDate
          && Number(existing.rows[0].amountReceivedPaise) === input.amountReceivedPaise
          && Number(existing.rows[0].discountGivenPaise) === input.discountGivenPaise
          && String(existing.rows[0].paymentMode) === input.paymentMode
          && String(existing.rows[0].notes) === (input.notes ?? '')
        if (!sameRequest) throw new PaymentRequestError(409, 'This payment retry key was already used for different payment details. Reopen the payment form and try again.')
        return { paymentCode: String(existing.rows[0].paymentCode), resultingStatus: String(existing.rows[0].resultingStatus), allocations: [], replayed: true }
      }
      const customer = await transaction.execute({ sql: `SELECT customers.credit_balance_paise, customers.customer_code, customers.name, customers.stb_number, customers.area_id, customers.is_deleted, areas.display_name AS area_name
        FROM customers JOIN areas ON areas.id = customers.area_id WHERE customers.id = ? AND customers.service_type = ?`, args: [input.customerId, input.serviceType] })
      if (!customer.rows[0]) throw new PaymentRequestError(404, 'Customer not found.')
      if (Number(customer.rows[0].is_deleted) === 1) throw new PaymentRequestError(409, 'Archived subscribers cannot receive payments. Restore the subscriber first.')
      const due = await transaction.execute({ sql: `SELECT COALESCE(SUM(charges.total - COALESCE(allocated.total, 0)), 0) AS value FROM invoices
        JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
        LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocated ON allocated.invoice_id = invoices.id
        WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0`, args: [input.customerId] })
      const maxDiscount = Math.max(0, Number(due.rows[0].value) - input.amountReceivedPaise - Number(customer.rows[0].credit_balance_paise))
      if (input.discountGivenPaise > 0 && Number(due.rows[0].value) === 0) throw new PaymentRequestError(400, 'Discounts can settle invoiced dues only. Generate the first invoice before discounting an opening due.')
      if (input.discountGivenPaise > maxDiscount) throw new PaymentRequestError(400, 'Discount cannot create advance credit.')
      const sequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['payment', input.serviceType] })
      const paymentCode = `PAY-${String(sequence.rows[0].last_number).padStart(3, '0')}`
      const payment = await transaction.execute({ sql: `INSERT INTO payments (payment_code, customer_id, service_type, customer_code_snapshot, customer_name_snapshot, area_id_snapshot, area_name_snapshot, stb_number_snapshot, payment_date, amount_received_paise, discount_given_paise, payment_mode, notes, resulting_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?) RETURNING id`, args: [paymentCode, input.customerId, input.serviceType, customer.rows[0].customer_code, customer.rows[0].name, customer.rows[0].area_id, customer.rows[0].area_name, customer.rows[0].stb_number, paymentDate, input.amountReceivedPaise, input.discountGivenPaise, input.paymentMode, input.notes ?? null, now] })
      await transaction.execute({ sql: 'UPDATE payments SET request_key = ? WHERE id = ?', args: [input.requestKey, payment.rows[0].id] })
      const replay = await rebuildCustomerLedger(transaction, input.customerId)
      const paymentId = Number(payment.rows[0].id)
      await recordAudit(transaction, { entityType: 'payment', entityId: paymentId, action: 'payment_recorded', details: { paymentCode, paymentDate, amountReceivedPaise: input.amountReceivedPaise, discountGivenPaise: input.discountGivenPaise, paymentMode: input.paymentMode } })
      return { paymentCode, resultingStatus: replay.paymentStatuses.find((item) => item.paymentId === paymentId)?.status, allocations: replay.allocations.filter((item) => item.paymentId === paymentId), replayed: false }
    })
    return response.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    if (error instanceof PaymentRequestError) return sendError(response, error.status, error.message)
    if (error instanceof z.ZodError || error instanceof DateInputError) return sendError(response, 400, error instanceof DateInputError ? error.message : 'Provide valid payment details.')
    console.error('Payment recording failed', error)
    return sendError(response, 500, 'Unable to record payment.')
  }
}
