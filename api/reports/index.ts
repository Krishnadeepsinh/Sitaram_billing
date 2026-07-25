import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { DateInputError, parseStrictDate, todayInBusinessTimezone } from '../../src/lib/date'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'

const scopeSchema = z.enum(['cable', 'broadband', 'all'])

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  try {
    const scope = scopeSchema.parse(request.query.serviceType)
    const from = typeof request.query.from === 'string' && request.query.from ? parseStrictDate(request.query.from) : '0000-01-01'
    const to = typeof request.query.to === 'string' && request.query.to ? parseStrictDate(request.query.to) : '9999-12-31'
    if (from > to) return sendError(response, 400, 'The From date must be on or before the To date.')
    const areaId = request.query.areaId ? z.coerce.number().int().positive().parse(request.query.areaId) : null
    const paymentMode = request.query.paymentMode === 'cash' || request.query.paymentMode === 'upi' ? request.query.paymentMode : null
    const discountGiven = request.query.discountGiven === '1' ? 1 : null
    const dateBasis = request.query.dateBasis === 'service' ? 'service' : 'issued'
    const limit = request.query.limit ? z.coerce.number().int().min(1).max(500).parse(request.query.limit) : 100
    const offset = request.query.offset ? z.coerce.number().int().nonnegative().parse(request.query.offset) : 0
    const service = scope === 'all' ? null : scope
    const invoiceDateFilter = dateBasis === 'service' ? 'period_start <= ? AND period_end >= ?' : 'issued_date BETWEEN ? AND ?'
    const invoiceDateArgs = dateBasis === 'service' ? [to, from] : [from, to]
    const invoiceTrendMonth = dateBasis === 'service' ? 'substr(MAX(period_start, ?),1,7)' : 'substr(issued_date,1,7)'
    const invoiceTrendArgs = dateBasis === 'service' ? [from, ...invoiceDateArgs] : invoiceDateArgs
    const db = database()
    const [billed, collected, discounts, today, outstanding, subscribers, payments, paymentCount, expenses, expenseCount, trends, quality, modeTotals, expiringSoon, areaBreakdown] = await Promise.all([
      db.execute({ sql: `SELECT COALESCE(SUM(current_period_amount_paise), 0) AS value FROM invoices WHERE is_deleted = 0 AND is_merged = 0 AND ${invoiceDateFilter} AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?)`, args: [...invoiceDateArgs, service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT COALESCE(SUM(amount_received_paise), 0) AS value FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date BETWEEN ? AND ? AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?) AND (? IS NULL OR payment_mode = ?) AND (? IS NULL OR discount_given_paise > 0)`, args: [from, to, service, service, areaId, areaId, paymentMode, paymentMode, discountGiven] }),
      db.execute({ sql: `SELECT COALESCE(SUM(discount_given_paise), 0) AS value FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date BETWEEN ? AND ? AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?) AND (? IS NULL OR payment_mode = ?) AND (? IS NULL OR discount_given_paise > 0)`, args: [from, to, service, service, areaId, areaId, paymentMode, paymentMode, discountGiven] }),
      db.execute({ sql: `SELECT COALESCE(SUM(amount_received_paise), 0) AS value FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date = ? AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?) AND (? IS NULL OR payment_mode = ?) AND (? IS NULL OR discount_given_paise > 0)`, args: [todayInBusinessTimezone(), service, service, areaId, areaId, paymentMode, paymentMode, discountGiven] }),
      db.execute({ sql: `SELECT
        (SELECT COALESCE(SUM(charges.total - COALESCE(allocated.total, 0)), 0) FROM invoices
          JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
          LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocated ON allocated.invoice_id = invoices.id
          WHERE invoices.is_deleted = 0 AND invoices.is_merged = 0 AND (? IS NULL OR invoices.service_type = ?) AND (? IS NULL OR invoices.area_id_snapshot = ?))
        + (SELECT COALESCE(SUM(MAX(customers.opening_balance_paise - customers.credit_balance_paise, 0)), 0) FROM customers
          WHERE customers.is_deleted = 0 AND customers.opening_balance_type = 'due'
          AND NOT EXISTS (SELECT 1 FROM invoices opening_invoice JOIN invoice_charges opening_charge ON opening_charge.invoice_id = opening_invoice.id
            WHERE opening_invoice.customer_id = customers.id AND opening_invoice.is_deleted = 0 AND opening_invoice.is_merged = 0 AND opening_charge.charge_type = 'opening_due')
          AND (? IS NULL OR customers.service_type = ?) AND (? IS NULL OR customers.area_id = ?)) AS value`, args: [service, service, areaId, areaId, service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT COUNT(*) AS value FROM customers WHERE status = 'active' AND is_deleted = 0 AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id = ?)`, args: [service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT id, payment_code AS paymentCode, payment_date AS paymentDate, amount_received_paise AS amountReceivedPaise, discount_given_paise AS discountGivenPaise, payment_mode AS paymentMode, resulting_status AS resultingStatus, customer_name_snapshot AS customerName, customer_code_snapshot AS customerCode, notes FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date BETWEEN ? AND ? AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?) AND (? IS NULL OR payment_mode = ?) AND (? IS NULL OR discount_given_paise > 0) ORDER BY payment_date DESC, created_at DESC LIMIT ? OFFSET ?`, args: [from, to, service, service, areaId, areaId, paymentMode, paymentMode, discountGiven, limit, offset] }),
      db.execute({ sql: `SELECT COUNT(*) AS value FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date BETWEEN ? AND ? AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?) AND (? IS NULL OR payment_mode = ?) AND (? IS NULL OR discount_given_paise > 0)`, args: [from, to, service, service, areaId, areaId, paymentMode, paymentMode, discountGiven] }),
      db.execute({ sql: 'SELECT id, category, expense_date AS expenseDate, amount_paise AS amountPaise, description FROM expenses WHERE is_deleted = 0 AND expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC LIMIT ? OFFSET ?', args: [from, to, limit, offset] }),
      db.execute({ sql: 'SELECT COUNT(*) AS count, COALESCE(SUM(amount_paise), 0) AS total FROM expenses WHERE is_deleted = 0 AND expense_date BETWEEN ? AND ?', args: [from, to] }),
      db.execute({ sql: `SELECT month, SUM(billed) AS billedPaise, SUM(collected) AS collectedPaise FROM (
        SELECT ${invoiceTrendMonth} AS month, current_period_amount_paise AS billed, 0 AS collected FROM invoices WHERE is_deleted = 0 AND is_merged = 0 AND ${invoiceDateFilter} AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?)
        UNION ALL SELECT substr(payment_date,1,7), 0, amount_received_paise FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date BETWEEN ? AND ? AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?) AND (? IS NULL OR payment_mode = ?) AND (? IS NULL OR discount_given_paise > 0)
        ) GROUP BY month ORDER BY month DESC LIMIT 12`, args: [...invoiceTrendArgs, service, service, areaId, areaId, from, to, service, service, areaId, areaId, paymentMode, paymentMode, discountGiven] }),
      db.execute({ sql: `SELECT COUNT(*) AS value FROM customers LEFT JOIN plans ON plans.id = customers.plan_id WHERE customers.is_deleted = 0 AND customers.status = 'active' AND (customers.plan_id IS NULL OR customers.installation_date IS NULL OR customers.next_billing_start_date IS NULL OR COALESCE(plans.is_active, 0) = 0) AND (? IS NULL OR customers.service_type = ?) AND (? IS NULL OR customers.area_id = ?)`, args: [service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT payment_mode AS mode, COALESCE(SUM(amount_received_paise), 0) AS amountPaise FROM payments WHERE is_deleted = 0 AND payment_mode IN ('cash','upi') AND payment_date BETWEEN ? AND ? AND (? IS NULL OR service_type = ?) AND (? IS NULL OR area_id_snapshot = ?) AND (? IS NULL OR payment_mode = ?) AND (? IS NULL OR discount_given_paise > 0) GROUP BY payment_mode`, args: [from, to, service, service, areaId, areaId, paymentMode, paymentMode, discountGiven] }),
      db.execute({ sql: `SELECT customers.id, customers.customer_code AS customerCode, customers.name, customers.phone, coverage.periodEnd
        FROM customers JOIN (SELECT customer_id, MAX(period_end) AS periodEnd FROM invoices WHERE is_deleted = 0 AND is_merged = 0 GROUP BY customer_id) coverage ON coverage.customer_id = customers.id
        WHERE customers.is_deleted = 0 AND customers.status = 'active' AND coverage.periodEnd BETWEEN ? AND date(?, '+3 days') AND (? IS NULL OR customers.service_type = ?) AND (? IS NULL OR customers.area_id = ?) ORDER BY coverage.periodEnd, customers.name LIMIT 50`, args: [todayInBusinessTimezone(), todayInBusinessTimezone(), service, service, areaId, areaId] }),
      db.execute({ sql: `SELECT areas.display_name AS areaName, COUNT(customers.id) AS subscriberCount FROM areas LEFT JOIN customers ON customers.area_id = areas.id AND customers.is_deleted = 0 AND customers.status = 'active' WHERE (? IS NULL OR areas.service_type = ?) AND (? IS NULL OR areas.id = ?) AND areas.is_deleted = 0 GROUP BY areas.id ORDER BY subscriberCount DESC, areas.display_name`, args: [service, service, areaId, areaId] }),
    ])
    const expenseTotal = Number(expenseCount.rows[0].total)
    const collectedValue = Number(collected.rows[0].value)
    const modeMap = Object.fromEntries(modeTotals.rows.map((row) => [String(row.mode), Number(row.amountPaise)]))
    return response.status(200).json({ scope, from, to, dateBasis, billedPaise: Number(billed.rows[0].value), collectedPaise: collectedValue, cashCollectedPaise: modeMap.cash ?? 0, upiCollectedPaise: modeMap.upi ?? 0, discountGivenPaise: Number(discounts.rows[0].value), todayCollectedPaise: Number(today.rows[0].value), outstandingPaise: Number(outstanding.rows[0].value), activeSubscribers: Number(subscribers.rows[0].value), expensePaise: expenseTotal, netPaise: scope === 'all' ? collectedValue - expenseTotal : collectedValue, netLabel: scope === 'all' ? 'Net revenue' : 'Net collections before shared expenses', dataQualityCount: Number(quality.rows[0].value), payments: payments.rows, paymentTotal: Number(paymentCount.rows[0].value), expenses: expenses.rows, expenseTotal: Number(expenseCount.rows[0].count), limit, offset, trends: [...trends.rows].reverse(), expiringSoon: expiringSoon.rows, areaBreakdown: areaBreakdown.rows })
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof DateInputError) return sendError(response, 400, 'Provide valid report filters.')
    console.error('Report request failed', error)
    return sendError(response, 500, 'Unable to load report.')
  }
}
