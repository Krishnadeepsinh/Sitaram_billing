import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { DateInputError, parseStrictDate } from '../../src/lib/date'
import { todayInBusinessTimezone } from '../../src/lib/date'
import { MAX_MONEY_PAISE } from '../../src/lib/billing'
import { recordAudit } from '../_lib/audit'
import { recomputeBillingPosition } from '../_lib/coverage'
import { database, withWriteTransaction } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'

const customerSchema = z.object({
  serviceType: serviceTypeSchema,
  name: z.string().trim().min(1).max(160),
  areaId: z.number().int().positive(),
  phone: z.string().trim().max(30).nullable().optional(),
  stbNumber: z.string().trim().max(80).nullable().optional(),
  planId: z.number().int().positive().nullable().optional(),
  installationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  openingBalancePaise: z.number().int().nonnegative().max(MAX_MONEY_PAISE).default(0),
  openingBalanceType: z.enum(['due', 'advance']).default('due'),
})
const updateCustomerSchema = z.object({
  id: z.number().int().positive(), serviceType: serviceTypeSchema, name: z.string().trim().min(1).max(160), areaId: z.number().int().positive(),
  phone: z.string().trim().max(30).nullable().optional(), stbNumber: z.string().trim().max(80).nullable().optional(), planId: z.number().int().positive().nullable().optional(),
  installationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), status: z.enum(['active', 'inactive']), restartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), statusReason: z.string().trim().max(250).optional(),
})
const restoreCustomerSchema = z.object({ id: z.number().int().positive(), serviceType: serviceTypeSchema, reason: z.string().trim().min(5).max(250) })
class CustomerRequestError extends Error { constructor(public status: number, message: string) { super(message) } }

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const includeDeleted = request.query.includeDeleted === '1'
      const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%'
      const result = await database().execute({
        sql: `SELECT customers.id, customers.customer_code AS customerCode, customers.name, customers.phone,
          customers.stb_number AS stbNumber, customers.status, customers.next_billing_start_date AS nextBillingStartDate,
          customers.installation_date AS installationDate, customers.area_id AS areaId, customers.plan_id AS planId,
          customers.credit_balance_paise AS creditBalancePaise, areas.display_name AS areaName, plans.name AS planName, plans.price_paise AS planPricePaise, COALESCE(plans.is_active, 0) AS planIsActive,
          COALESCE(debt.amountDuePaise, 0) AS amountDuePaise, COALESCE(debt.openInvoiceCount, 0) AS openInvoiceCount,
          debt.oldestDuePeriodStart, debt.latestDuePeriodEnd, coverage.latestPeriodStart, coverage.latestPeriodEnd,
          CASE WHEN coverage.latestPeriodEnd IS NULL THEN 'never_billed'
            WHEN coverage.currentlyCovered = 1 THEN CASE WHEN coverage.latestPeriodEnd = ? THEN 'expiring_today' ELSE 'active' END
            WHEN coverage.latestPeriodStart > ? THEN 'future' WHEN coverage.latestPeriodEnd < ? THEN 'expired' ELSE 'active' END AS coverageStatus,
          COALESCE(coverage.hasHistoricalGap, 0) AS hasHistoricalGap
          FROM customers JOIN areas ON areas.id = customers.area_id
          LEFT JOIN plans ON plans.id = customers.plan_id
          LEFT JOIN (
            SELECT invoices.customer_id,
              SUM(CASE WHEN charges.total > COALESCE(allocated.total, 0) THEN charges.total - COALESCE(allocated.total, 0) ELSE 0 END) AS amountDuePaise,
              SUM(CASE WHEN charges.total > COALESCE(allocated.total, 0) THEN 1 ELSE 0 END) AS openInvoiceCount,
              MIN(CASE WHEN charges.total > COALESCE(allocated.total, 0) THEN invoices.period_start END) AS oldestDuePeriodStart,
              MAX(CASE WHEN charges.total > COALESCE(allocated.total, 0) THEN invoices.period_end END) AS latestDuePeriodEnd
            FROM invoices
            JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
            LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocated ON allocated.invoice_id = invoices.id
            WHERE invoices.is_deleted = 0 AND invoices.is_merged = 0
            GROUP BY invoices.customer_id
          ) debt ON debt.customer_id = customers.id
          LEFT JOIN (
            SELECT ranked.customer_id,
              MAX(CASE WHEN ranked.position = 1 THEN ranked.period_start END) AS latestPeriodStart,
              MAX(CASE WHEN ranked.position = 1 THEN ranked.period_end END) AS latestPeriodEnd,
              MAX(CASE WHEN ranked.period_start <= ? AND ranked.period_end >= ? THEN 1 ELSE 0 END) AS currentlyCovered,
              MAX(CASE WHEN ranked.previousEnd IS NOT NULL AND ranked.period_start > date(ranked.previousEnd, '+1 day') THEN 1 ELSE 0 END) AS hasHistoricalGap
            FROM (SELECT invoices.customer_id, invoices.period_start, invoices.period_end,
              ROW_NUMBER() OVER (PARTITION BY invoices.customer_id ORDER BY invoices.period_end DESC, invoices.id DESC) AS position,
              LAG(invoices.period_end) OVER (PARTITION BY invoices.customer_id ORDER BY invoices.period_start, invoices.id) AS previousEnd
              FROM invoices WHERE invoices.is_deleted = 0 AND invoices.is_merged = 0) ranked GROUP BY ranked.customer_id
          ) coverage ON coverage.customer_id = customers.id
          WHERE customers.service_type = ? AND customers.is_deleted = ${includeDeleted ? '1' : '0'}
          AND (customers.name LIKE ? OR customers.customer_code LIKE ? OR COALESCE(customers.stb_number, '') LIKE ? OR COALESCE(customers.phone, '') LIKE ? OR areas.display_name LIKE ?)
          ORDER BY customers.sort_order`,
        args: [todayInBusinessTimezone(), todayInBusinessTimezone(), todayInBusinessTimezone(), todayInBusinessTimezone(), todayInBusinessTimezone(), serviceType, query, query, query, query, query],
      })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'PUT') {
      const input = body(updateCustomerSchema, request.body)
      await withWriteTransaction(async (transaction) => {
        const current = await transaction.execute({ sql: 'SELECT status, installation_date, next_billing_start_date, plan_id FROM customers WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [input.id, input.serviceType] })
        if (!current.rows[0]) throw new CustomerRequestError(404, 'Customer not found.')
        const area = await transaction.execute({ sql: 'SELECT id FROM areas WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [input.areaId, input.serviceType] })
        if (!area.rows[0]) throw new CustomerRequestError(400, 'Choose an active area for this service.')
        const plan = input.planId ? await transaction.execute({ sql: 'SELECT id, name, price_paise FROM plans WHERE id = ? AND service_type = ? AND (is_active = 1 OR id = (SELECT plan_id FROM customers WHERE id = ?))', args: [input.planId, input.serviceType, input.id] }) : undefined
        if (input.planId && !plan?.rows[0]) throw new CustomerRequestError(400, 'Choose an active plan for this service.')
        const installationDate = input.installationDate ? parseStrictDate(input.installationDate) : null
        const invoiceDates = await transaction.execute({ sql: 'SELECT MIN(period_start) AS firstPeriodStart, COUNT(*) AS count FROM invoices WHERE customer_id = ? AND is_deleted = 0', args: [input.id] })
        if (Number(invoiceDates.rows[0].count) > 0 && (!installationDate || installationDate > String(invoiceDates.rows[0].firstPeriodStart))) throw new CustomerRequestError(409, `Installation date is locked by billing history and must remain on or before ${invoiceDates.rows[0].firstPeriodStart}.`)
        let nextBillingStartDate: string | undefined
        if (current.rows[0].status === 'inactive' && input.status === 'active') {
          nextBillingStartDate = parseStrictDate(input.restartDate || todayInBusinessTimezone())
          const lastInvoice = await transaction.execute({ sql: 'SELECT MAX(period_end) AS periodEnd FROM invoices WHERE customer_id = ? AND is_deleted = 0', args: [input.id] })
          if (lastInvoice.rows[0].periodEnd && nextBillingStartDate <= String(lastInvoice.rows[0].periodEnd)) throw new CustomerRequestError(409, 'Restart date must be after the customer’s latest invoice period.')
        } else if (!current.rows[0].next_billing_start_date && installationDate) {
          nextBillingStartDate = installationDate > todayInBusinessTimezone() ? installationDate : todayInBusinessTimezone()
        } else if (installationDate && installationDate !== current.rows[0].installation_date) {
          const invoice = await transaction.execute({ sql: 'SELECT id FROM invoices WHERE customer_id = ? AND is_deleted = 0 LIMIT 1', args: [input.id] })
          if (!invoice.rows[0]) nextBillingStartDate = installationDate > todayInBusinessTimezone() ? installationDate : todayInBusinessTimezone()
        }
        if (input.stbNumber) {
          const duplicate = await transaction.execute({ sql: `SELECT id FROM customers WHERE service_type = ? AND id <> ? AND is_deleted = 0 AND lower(trim(stb_number)) = lower(trim(?)) LIMIT 1`, args: [input.serviceType, input.id, input.stbNumber] })
          if (duplicate.rows[0]) throw new CustomerRequestError(409, 'That active STB number is already assigned.')
        }
        const resolvedNextBilling = installationDate ? nextBillingStartDate ?? String(current.rows[0].next_billing_start_date || installationDate) : null
        await transaction.execute({ sql: `UPDATE customers SET name = ?, area_id = ?, phone = ?, stb_number = ?, plan_id = ?, installation_date = ?, status = ?, next_billing_start_date = ? WHERE id = ?`, args: [input.name, input.areaId, input.phone || null, input.stbNumber || null, input.planId ?? null, installationDate, input.status, resolvedNextBilling, input.id] })
        const now = new Date().toISOString()
        if (current.rows[0].status !== input.status) {
          const effectiveDate = input.status === 'active' ? parseStrictDate(input.restartDate || todayInBusinessTimezone()) : todayInBusinessTimezone()
          await transaction.execute({ sql: 'INSERT INTO customer_status_history (customer_id, status, effective_date, reason, created_at) VALUES (?, ?, ?, ?, ?)', args: [input.id, input.status, effectiveDate, input.statusReason?.trim() || (input.status === 'active' ? 'Service reactivated' : 'Service deactivated'), now] })
          await recomputeBillingPosition(transaction, input.id)
        }
        if (input.planId && Number(current.rows[0].plan_id) !== input.planId && plan?.rows[0]) {
          const effectiveDate = resolvedNextBilling || installationDate || todayInBusinessTimezone()
          await transaction.execute({ sql: 'INSERT INTO customer_plan_history (customer_id, plan_id, plan_name_snapshot, price_paise_snapshot, effective_date, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [input.id, input.planId, plan.rows[0].name, plan.rows[0].price_paise, effectiveDate, 'Plan changed for future billing', now] })
        } else if (!input.planId && current.rows[0].plan_id) {
          const effectiveDate = resolvedNextBilling || installationDate || todayInBusinessTimezone()
          await transaction.execute({ sql: 'INSERT INTO customer_plan_gaps (customer_id, effective_date, reason, created_at) VALUES (?, ?, ?, ?)', args: [input.id, effectiveDate, 'Plan assignment removed', now] })
        }
        await recordAudit(transaction, { entityType: 'customer', entityId: input.id, action: 'customer_updated', reason: input.statusReason, details: { status: input.status, planId: input.planId ?? null, installationDate } })
      })
      return response.status(204).end()
    }
    if (request.method === 'PATCH') {
      const input = body(restoreCustomerSchema, request.body)
      await withWriteTransaction(async (transaction) => {
        const customer = await transaction.execute({ sql: 'SELECT id FROM customers WHERE id = ? AND service_type = ? AND is_deleted = 1', args: [input.id, input.serviceType] })
        if (!customer.rows[0]) throw new CustomerRequestError(404, 'Archived customer not found.')
        await transaction.execute({ sql: 'UPDATE customers SET is_deleted = 0 WHERE id = ?', args: [input.id] })
        await recordAudit(transaction, { entityType: 'customer', entityId: input.id, action: 'customer_restored', reason: input.reason })
      })
      return response.status(204).end()
    }
    if (request.method === 'DELETE') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const id = z.coerce.number().int().positive().parse(request.query.id)
      const reason = z.string().trim().min(5).max(250).parse(request.query.reason)
      await withWriteTransaction(async (transaction) => {
        const result = await transaction.execute({ sql: 'UPDATE customers SET is_deleted = 1 WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [id, serviceType] })
        if (!result.rowsAffected) throw new CustomerRequestError(404, 'Customer not found.')
        await recordAudit(transaction, { entityType: 'customer', entityId: id, action: 'customer_archived', reason })
      })
      return response.status(204).end()
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    const input = body(customerSchema, request.body)
    const now = new Date().toISOString()
    const installationDate = input.installationDate ? parseStrictDate(input.installationDate) : null
    const created = await withWriteTransaction(async (transaction) => {
      const area = await transaction.execute({ sql: 'SELECT id FROM areas WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [input.areaId, input.serviceType] })
      const plan = input.planId ? await transaction.execute({ sql: 'SELECT id FROM plans WHERE id = ? AND service_type = ? AND is_active = 1', args: [input.planId, input.serviceType] }) : undefined
      if (!area.rows[0]) throw new Error('AREA_INVALID')
      if (input.planId && !plan?.rows[0]) throw new Error('PLAN_INVALID')
      if (input.stbNumber) {
        const duplicate = await transaction.execute({ sql: `SELECT id FROM customers WHERE service_type = ? AND is_deleted = 0 AND lower(trim(stb_number)) = lower(trim(?)) LIMIT 1`, args: [input.serviceType, input.stbNumber] })
        if (duplicate.rows[0]) throw new Error('STB_DUPLICATE')
      }
      const sequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['customer', input.serviceType] })
      const customerCode = `CUST-${String(sequence.rows[0].last_number).padStart(3, '0')}`
      const order = await transaction.execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM customers WHERE service_type = ?', args: [input.serviceType] })
      const credit = input.openingBalanceType === 'advance' ? input.openingBalancePaise : 0
      const nextBillingStartDate = installationDate ? (installationDate > todayInBusinessTimezone() ? installationDate : todayInBusinessTimezone()) : null
      const result = await transaction.execute({ sql: `INSERT INTO customers (customer_code, service_type, name, area_id, phone, stb_number, plan_id, installation_date,
          next_billing_start_date, opening_balance_paise, opening_balance_type, credit_balance_paise, sort_order, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [customerCode, input.serviceType, input.name, input.areaId, input.phone ?? null, input.stbNumber || null,
          input.planId ?? null, installationDate, nextBillingStartDate, input.openingBalancePaise, input.openingBalanceType, credit, Number(order.rows[0].next_order), now] })
      const customerId = Number(result.lastInsertRowid)
      await transaction.execute({ sql: 'INSERT INTO customer_status_history (customer_id, status, effective_date, reason, created_at) VALUES (?, ?, ?, ?, ?)', args: [customerId, 'active', installationDate ?? todayInBusinessTimezone(), 'Customer created', now] })
      if (input.planId && plan?.rows[0]) {
        const planDetails = await transaction.execute({ sql: 'SELECT name, price_paise FROM plans WHERE id = ?', args: [input.planId] })
        await transaction.execute({ sql: 'INSERT INTO customer_plan_history (customer_id, plan_id, plan_name_snapshot, price_paise_snapshot, effective_date, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [customerId, input.planId, planDetails.rows[0].name, planDetails.rows[0].price_paise, installationDate ?? todayInBusinessTimezone(), 'Initial plan assignment', now] })
      }
      await recordAudit(transaction, { entityType: 'customer', entityId: customerId, action: 'customer_created', details: { customerCode, installationDate, planId: input.planId ?? null } })
      return { id: customerId, customerCode }
    })
    return response.status(201).json(created)
  } catch (error) {
    if (error instanceof CustomerRequestError) return sendError(response, error.status, error.message)
    if (error instanceof z.ZodError || error instanceof DateInputError) return sendError(response, 400, error instanceof DateInputError ? error.message : 'Provide valid customer details.')
    if (error instanceof Error && error.message === 'AREA_INVALID') return sendError(response, 400, 'Choose an active area for this service.')
    if (error instanceof Error && error.message === 'PLAN_INVALID') return sendError(response, 400, 'Choose an active plan for this service.')
    if (error instanceof Error && error.message === 'STB_DUPLICATE') return sendError(response, 409, 'That active STB number is already assigned.')
    if (error instanceof Error && error.message.includes('UNIQUE')) return sendError(response, 409, 'That active STB number is already assigned.')
    console.error('Customer request failed', error)
    return sendError(response, 500, 'Unable to save customer.')
  }
}
