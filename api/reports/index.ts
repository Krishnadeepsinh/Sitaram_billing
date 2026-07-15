import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { parseStrictDate, todayInBusinessTimezone } from '../../src/lib/date'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'

const scopeSchema = z.enum(['cable', 'broadband', 'all'])

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  try {
    const scope = scopeSchema.parse(request.query.serviceType)
    const from = typeof request.query.from === 'string' && request.query.from ? parseStrictDate(request.query.from) : '0000-01-01'
    const to = typeof request.query.to === 'string' && request.query.to ? parseStrictDate(request.query.to) : '9999-12-31'
    if (from > to) return sendError(response, 400, 'The From date must be on or before the To date.')
    const areaId = request.query.areaId ? z.coerce.number().int().positive().parse(request.query.areaId) : null
    const paymentMode = request.query.paymentMode === 'cash' || request.query.paymentMode === 'upi' ? request.query.paymentMode : null
    const service = scope === 'all' ? null : scope
    const db = database()
    const [billed, collected, today, outstanding, subscribers, payments, expenses, trends, quality] = await Promise.all([
      db.execute({ sql: `SELECT COALESCE(SUM(invoices.current_period_amount_paise), 0) AS value FROM invoices JOIN customers ON customers.id = invoices.customer_id WHERE invoices.is_deleted = 0 AND invoices.is_merged = 0 AND invoices.issued_date BETWEEN ? AND ? AND (? IS NULL OR invoices.service_type = ?) AND (? IS NULL OR customers.area_id = ?)`, args: [from, to, service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT COALESCE(SUM(payments.amount_received_paise), 0) AS value FROM payments JOIN customers ON customers.id = payments.customer_id WHERE payments.is_deleted = 0 AND payments.payment_mode IN ('cash','upi') AND payments.payment_date BETWEEN ? AND ? AND (? IS NULL OR payments.service_type = ?) AND (? IS NULL OR customers.area_id = ?) AND (? IS NULL OR payments.payment_mode = ?)`, args: [from, to, service, service, areaId, areaId, paymentMode, paymentMode] }),
      db.execute({ sql: `SELECT COALESCE(SUM(amount_received_paise), 0) AS value FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date = ? AND (? IS NULL OR service_type = ?)`, args: [todayInBusinessTimezone(), service, service] }),
      db.execute({ sql: `SELECT COALESCE(SUM(charges.total - COALESCE(allocated.total, 0)), 0) AS value FROM invoices JOIN customers ON customers.id = invoices.customer_id JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocated ON allocated.invoice_id = invoices.id WHERE invoices.is_deleted = 0 AND invoices.is_merged = 0 AND (? IS NULL OR invoices.service_type = ?) AND (? IS NULL OR customers.area_id = ?)`, args: [service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT COUNT(*) AS value FROM customers WHERE status = 'active' AND is_deleted = 0 AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id = ?)`, args: [service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT payments.id, payments.payment_code AS paymentCode, payments.payment_date AS paymentDate, payments.amount_received_paise AS amountReceivedPaise, payments.discount_given_paise AS discountGivenPaise, payments.payment_mode AS paymentMode, payments.resulting_status AS resultingStatus, customers.name AS customerName, customers.customer_code AS customerCode FROM payments JOIN customers ON customers.id = payments.customer_id WHERE payments.is_deleted = 0 AND payments.payment_mode IN ('cash','upi') AND payments.payment_date BETWEEN ? AND ? AND (? IS NULL OR payments.service_type = ?) AND (? IS NULL OR customers.area_id = ?) AND (? IS NULL OR payments.payment_mode = ?) ORDER BY payments.payment_date DESC, payments.created_at DESC LIMIT 500`, args: [from, to, service, service, areaId, areaId, paymentMode, paymentMode] }),
      db.execute({ sql: 'SELECT id, category, expense_date AS expenseDate, amount_paise AS amountPaise, description FROM expenses WHERE is_deleted = 0 AND expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC', args: [from, to] }),
      db.execute({ sql: `SELECT month, SUM(billed) AS billedPaise, SUM(collected) AS collectedPaise FROM (
        SELECT substr(issued_date,1,7) AS month, current_period_amount_paise AS billed, 0 AS collected FROM invoices WHERE is_deleted = 0 AND is_merged = 0 AND (? IS NULL OR service_type = ?)
        UNION ALL SELECT substr(payment_date,1,7), 0, amount_received_paise FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND (? IS NULL OR service_type = ?)
        ) GROUP BY month ORDER BY month DESC LIMIT 12`, args: [service, service, service, service] }),
      db.execute({ sql: `SELECT COUNT(*) AS value FROM customers WHERE is_deleted = 0 AND status = 'active' AND (plan_id IS NULL OR installation_date IS NULL) AND (? IS NULL OR service_type = ?)`, args: [service, service] }),
    ])
    const expenseTotal = expenses.rows.reduce((sum, row) => sum + Number(row.amountPaise), 0)
    const collectedValue = Number(collected.rows[0].value)
    return response.status(200).json({ scope, from, to, billedPaise: Number(billed.rows[0].value), collectedPaise: collectedValue, todayCollectedPaise: Number(today.rows[0].value), outstandingPaise: Number(outstanding.rows[0].value), activeSubscribers: Number(subscribers.rows[0].value), expensePaise: expenseTotal, netPaise: scope === 'all' ? collectedValue - expenseTotal : collectedValue, netLabel: scope === 'all' ? 'Net revenue' : 'Net collections before shared expenses', dataQualityCount: Number(quality.rows[0].value), payments: payments.rows, expenses: expenses.rows, trends: [...trends.rows].reverse() })
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes('date')) return sendError(response, 400, 'Provide valid report filters.')
    console.error('Report request failed', error)
    return sendError(response, 500, 'Unable to load report.')
  }
}
