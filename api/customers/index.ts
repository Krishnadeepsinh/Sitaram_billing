import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { parseStrictDate } from '../../src/lib/date'
import { todayInBusinessTimezone } from '../../src/lib/date'
import { database } from '../_lib/db'
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
  openingBalancePaise: z.number().int().nonnegative().default(0),
  openingBalanceType: z.enum(['due', 'advance']).default('due'),
})
const updateCustomerSchema = z.object({
  id: z.number().int().positive(), serviceType: serviceTypeSchema, name: z.string().trim().min(1).max(160), areaId: z.number().int().positive(),
  phone: z.string().trim().max(30).nullable().optional(), stbNumber: z.string().trim().max(80).nullable().optional(), planId: z.number().int().positive().nullable().optional(),
  installationDate: z.string().nullable().optional(), status: z.enum(['active', 'inactive']), restartDate: z.string().nullable().optional(),
})

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const includeDeleted = request.query.includeDeleted === '1'
      const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%'
      const result = await database().execute({
        sql: `SELECT customers.id, customers.customer_code AS customerCode, customers.name, customers.phone,
          customers.stb_number AS stbNumber, customers.status, customers.next_billing_start_date AS nextBillingStartDate,
          customers.installation_date AS installationDate, customers.area_id AS areaId, customers.plan_id AS planId,
          customers.credit_balance_paise AS creditBalancePaise, areas.display_name AS areaName, plans.name AS planName,
          COALESCE(debt.amountDuePaise, 0) AS amountDuePaise, COALESCE(debt.openInvoiceCount, 0) AS openInvoiceCount,
          debt.oldestDuePeriodStart, debt.latestDuePeriodEnd
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
          WHERE customers.service_type = ? AND customers.is_deleted = ${includeDeleted ? '1' : '0'}
          AND (customers.name LIKE ? OR customers.customer_code LIKE ? OR COALESCE(customers.stb_number, '') LIKE ? OR COALESCE(customers.phone, '') LIKE ? OR areas.display_name LIKE ?)
          ORDER BY customers.sort_order`,
        args: [serviceType, query, query, query, query, query],
      })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'PUT') {
      const input = body(updateCustomerSchema, request.body)
      const transaction = await database().transaction('write')
      try {
        const current = await transaction.execute({ sql: 'SELECT status FROM customers WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [input.id, input.serviceType] })
        if (!current.rows[0]) { await transaction.rollback(); return sendError(response, 404, 'Customer not found.') }
        const area = await transaction.execute({ sql: 'SELECT id FROM areas WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [input.areaId, input.serviceType] })
        if (!area.rows[0]) { await transaction.rollback(); return sendError(response, 400, 'Choose an active area for this service.') }
        if (input.planId) {
          const plan = await transaction.execute({ sql: 'SELECT id FROM plans WHERE id = ? AND service_type = ? AND (is_active = 1 OR id = (SELECT plan_id FROM customers WHERE id = ?))', args: [input.planId, input.serviceType, input.id] })
          if (!plan.rows[0]) { await transaction.rollback(); return sendError(response, 400, 'Choose an active plan for this service.') }
        }
        const installationDate = input.installationDate ? parseStrictDate(input.installationDate) : null
        let nextBillingStartDate: string | undefined
        if (current.rows[0].status === 'inactive' && input.status === 'active') {
          nextBillingStartDate = parseStrictDate(input.restartDate || todayInBusinessTimezone())
          const lastInvoice = await transaction.execute({ sql: 'SELECT MAX(period_end) AS periodEnd FROM invoices WHERE customer_id = ? AND is_deleted = 0', args: [input.id] })
          if (lastInvoice.rows[0].periodEnd && nextBillingStartDate <= String(lastInvoice.rows[0].periodEnd)) { await transaction.rollback(); return sendError(response, 409, 'Restart date must be after the customer’s latest invoice period.') }
        }
        await transaction.execute({ sql: `UPDATE customers SET name = ?, area_id = ?, phone = ?, stb_number = ?, plan_id = ?, installation_date = ?, status = ?, next_billing_start_date = COALESCE(?, next_billing_start_date) WHERE id = ?`, args: [input.name, input.areaId, input.phone || null, input.stbNumber || null, input.planId ?? null, installationDate, input.status, nextBillingStartDate ?? null, input.id] })
        await transaction.commit()
        return response.status(204).end()
      } catch (error) { await transaction.rollback(); throw error }
    }
    if (request.method === 'DELETE') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const id = z.coerce.number().int().positive().parse(request.query.id)
      const result = await database().execute({ sql: 'UPDATE customers SET is_deleted = 1 WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [id, serviceType] })
      if (!result.rowsAffected) return sendError(response, 404, 'Customer not found.')
      return response.status(204).end()
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'PUT', 'DELETE'])
    const input = body(customerSchema, request.body)
    const now = new Date().toISOString()
    const installationDate = input.installationDate ? parseStrictDate(input.installationDate) : null
    const transaction = await database().transaction('write')
    try {
      const area = await transaction.execute({ sql: 'SELECT id FROM areas WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [input.areaId, input.serviceType] })
      const plan = input.planId ? await transaction.execute({ sql: 'SELECT id FROM plans WHERE id = ? AND service_type = ? AND is_active = 1', args: [input.planId, input.serviceType] }) : undefined
      if (!area.rows[0]) throw new Error('AREA_INVALID')
      if (input.planId && !plan?.rows[0]) throw new Error('PLAN_INVALID')
      const sequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['customer', input.serviceType] })
      const customerCode = `CUST-${String(sequence.rows[0].last_number).padStart(3, '0')}`
      const order = await transaction.execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM customers WHERE service_type = ?', args: [input.serviceType] })
      const credit = input.openingBalanceType === 'advance' ? input.openingBalancePaise : 0
      const result = await transaction.execute({ sql: `INSERT INTO customers (customer_code, service_type, name, area_id, phone, stb_number, plan_id, installation_date,
          next_billing_start_date, opening_balance_paise, opening_balance_type, credit_balance_paise, sort_order, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [customerCode, input.serviceType, input.name, input.areaId, input.phone ?? null, input.stbNumber || null,
          input.planId ?? null, installationDate, installationDate, input.openingBalancePaise, input.openingBalanceType, credit, Number(order.rows[0].next_order), now] })
      await transaction.commit()
      return response.status(201).json({ id: Number(result.lastInsertRowid), customerCode })
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide valid customer details.')
    if (error instanceof Error && error.message === 'AREA_INVALID') return sendError(response, 400, 'Choose an active area for this service.')
    if (error instanceof Error && error.message === 'PLAN_INVALID') return sendError(response, 400, 'Choose an active plan for this service.')
    if (error instanceof Error && error.message.includes('UNIQUE')) return sendError(response, 409, 'That active STB number is already assigned.')
    console.error('Customer request failed', error)
    return sendError(response, 500, 'Unable to save customer.')
  }
}
