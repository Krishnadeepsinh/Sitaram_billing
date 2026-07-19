import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { MAX_MONEY_PAISE } from '../../src/lib/billing'
import { todayInBusinessTimezone } from '../../src/lib/date'
import { recordAudit } from '../_lib/audit'
import { database, withWriteTransaction } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'

const planSchema = z.object({
  serviceType: serviceTypeSchema,
  name: z.string().trim().min(1).max(100),
  pricePaise: z.number().int().positive().max(MAX_MONEY_PAISE),
  units: z.string().trim().max(120).default(''),
})
const updatePlanSchema = planSchema.extend({ id: z.number().int().positive(), isActive: z.boolean() })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const result = await database().execute({
        sql: `SELECT plans.id, plans.name, plans.price_paise AS pricePaise, plans.units, plans.is_active AS isActive,
          COUNT(customers.id) AS subscriberCount
          FROM plans LEFT JOIN customers ON customers.plan_id = plans.id AND customers.is_deleted = 0 AND customers.status = 'active'
          WHERE plans.service_type = ? GROUP BY plans.id ORDER BY plans.sort_order`,
        args: [serviceType],
      })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'PUT') {
      const input = body(updatePlanSchema, request.body)
      await withWriteTransaction(async (transaction) => {
        const duplicate = await transaction.execute({ sql: 'SELECT id FROM plans WHERE service_type = ? AND lower(trim(name)) = lower(trim(?)) AND id <> ? LIMIT 1', args: [input.serviceType, input.name, input.id] })
        if (duplicate.rows.length) throw new Error('PLAN_DUPLICATE')
        const current = await transaction.execute({ sql: 'SELECT name, price_paise FROM plans WHERE id = ? AND service_type = ?', args: [input.id, input.serviceType] })
        if (!current.rows[0]) throw new Error('PLAN_MISSING')
        await transaction.execute({ sql: 'UPDATE plans SET name = ?, price_paise = ?, units = ?, is_active = ? WHERE id = ?', args: [input.name, input.pricePaise, input.units, input.isActive ? 1 : 0, input.id] })
        if (String(current.rows[0].name) !== input.name || Number(current.rows[0].price_paise) !== input.pricePaise) {
          const customers = await transaction.execute({ sql: 'SELECT id, next_billing_start_date AS nextStart FROM customers WHERE plan_id = ? AND is_deleted = 0', args: [input.id] })
          const today = todayInBusinessTimezone(); const now = new Date().toISOString()
          for (const customer of customers.rows) await transaction.execute({ sql: 'INSERT INTO customer_plan_history (customer_id, plan_id, plan_name_snapshot, price_paise_snapshot, effective_date, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [customer.id, input.id, input.name, input.pricePaise, String(customer.nextStart ?? today) > today ? customer.nextStart : today, 'Plan details changed for future billing', now] })
        }
        await recordAudit(transaction, { entityType: 'plan', entityId: input.id, action: 'plan_updated', details: { name: input.name, pricePaise: input.pricePaise, isActive: input.isActive } })
      })
      return response.status(204).end()
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'PUT'])
    const input = body(planSchema, request.body)
    const duplicate = await database().execute({ sql: 'SELECT id FROM plans WHERE service_type = ? AND lower(trim(name)) = lower(trim(?)) LIMIT 1', args: [input.serviceType, input.name] })
    if (duplicate.rows.length) return sendError(response, 409, 'A plan with this name already exists. Edit the existing plan instead.')
    const order = await database().execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM plans WHERE service_type = ?', args: [input.serviceType] })
    const result = await database().execute({
      sql: 'INSERT INTO plans (service_type, name, price_paise, duration_days, units, sort_order, created_at) VALUES (?, ?, ?, 30, ?, ?, ?)',
      args: [input.serviceType, input.name, input.pricePaise, input.units, Number(order.rows[0].next_order), new Date().toISOString()],
    })
    return response.status(201).json({ id: Number(result.lastInsertRowid) })
  } catch (error) {
    if (error instanceof Error && error.message === 'PLAN_DUPLICATE') return sendError(response, 409, 'A plan with this name already exists. Edit the existing plan instead.')
    if (error instanceof Error && error.message === 'PLAN_MISSING') return sendError(response, 404, 'Plan not found.')
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide valid plan details.')
    console.error('Plan request failed', error)
    return sendError(response, 500, 'Unable to save plan.')
  }
}
