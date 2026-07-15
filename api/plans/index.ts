import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'

const planSchema = z.object({
  serviceType: serviceTypeSchema,
  name: z.string().trim().min(1).max(100),
  pricePaise: z.number().int().nonnegative(),
  units: z.string().trim().max(120).default(''),
})
const updatePlanSchema = planSchema.extend({ id: z.number().int().positive(), isActive: z.boolean() })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const result = await database().execute({
        sql: `SELECT plans.id, plans.name, plans.price_paise AS pricePaise, plans.units, plans.is_active AS isActive,
          COUNT(customers.id) AS subscriberCount
          FROM plans LEFT JOIN customers ON customers.plan_id = plans.id AND customers.is_deleted = 0
          WHERE plans.service_type = ? GROUP BY plans.id ORDER BY plans.sort_order`,
        args: [serviceType],
      })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'PUT') {
      const input = body(updatePlanSchema, request.body)
      const duplicate = await database().execute({ sql: 'SELECT id FROM plans WHERE service_type = ? AND lower(trim(name)) = lower(trim(?)) AND id <> ? LIMIT 1', args: [input.serviceType, input.name, input.id] })
      if (duplicate.rows.length) return sendError(response, 409, 'A plan with this name already exists. Edit the existing plan instead.')
      const result = await database().execute({ sql: 'UPDATE plans SET name = ?, price_paise = ?, units = ?, is_active = ? WHERE id = ? AND service_type = ?', args: [input.name, input.pricePaise, input.units, input.isActive ? 1 : 0, input.id, input.serviceType] })
      if (!result.rowsAffected) return sendError(response, 404, 'Plan not found.')
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
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide valid plan details.')
    console.error('Plan request failed', error)
    return sendError(response, 500, 'Unable to save plan.')
  }
}
