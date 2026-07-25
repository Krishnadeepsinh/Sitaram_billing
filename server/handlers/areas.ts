import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { database } from '../lib/db.js'
import { methodNotAllowed, sendError } from '../lib/http.js'
import { requireSession } from '../lib/session.js'
import { body, normalizeArea, serviceTypeSchema } from '../lib/validation.js'

const createAreaSchema = z.object({ serviceType: serviceTypeSchema, displayName: z.string().trim().min(1).max(120) })
const updateAreaSchema = createAreaSchema.extend({ id: z.number().int().positive() })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const result = await database().execute({ sql: 'SELECT id, display_name AS displayName FROM areas WHERE service_type = ? AND is_deleted = 0 ORDER BY sort_order', args: [serviceType] })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'PUT') {
      const input = body(updateAreaSchema, request.body)
      const existing = await database().execute({ sql: 'SELECT id FROM areas WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [input.id, input.serviceType] })
      if (!existing.rows[0]) return sendError(response, 404, 'Area not found.')
      await database().execute({ sql: 'UPDATE areas SET display_name = ?, normalized_key = ? WHERE id = ?', args: [input.displayName, normalizeArea(input.displayName), input.id] })
      return response.status(204).end()
    }
    if (request.method === 'DELETE') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const id = z.coerce.number().int().positive().parse(request.query.id)
      const referenced = await database().execute({ sql: 'SELECT id FROM customers WHERE area_id = ? LIMIT 1', args: [id] })
      if (referenced.rows[0]) return sendError(response, 409, 'Reassign customers before deleting this area.')
      const result = await database().execute({ sql: 'UPDATE areas SET is_deleted = 1 WHERE id = ? AND service_type = ? AND is_deleted = 0', args: [id, serviceType] })
      if (!result.rowsAffected) return sendError(response, 404, 'Area not found.')
      return response.status(204).end()
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'PUT', 'DELETE'])
    const input = body(createAreaSchema, request.body)
    const normalizedKey = normalizeArea(input.displayName)
    const existing = await database().execute({ sql: 'SELECT id, is_deleted FROM areas WHERE service_type = ? AND normalized_key = ? LIMIT 1', args: [input.serviceType, normalizedKey] })
    if (existing.rows[0]) {
      const area = existing.rows[0]
      if (Number(area.is_deleted) === 1) await database().execute({ sql: 'UPDATE areas SET is_deleted = 0, display_name = ? WHERE id = ?', args: [input.displayName, area.id] })
      return response.status(200).json({ id: Number(area.id), reused: true })
    }
    const order = await database().execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM areas WHERE service_type = ?', args: [input.serviceType] })
    const result = await database().execute({ sql: 'INSERT INTO areas (service_type, display_name, normalized_key, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', args: [input.serviceType, input.displayName, normalizedKey, Number(order.rows[0].next_order), new Date().toISOString()] })
    return response.status(201).json({ id: Number(result.lastInsertRowid), reused: false })
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide a valid service type and area name.')
    if (error instanceof Error && error.message.includes('UNIQUE')) return sendError(response, 409, 'An area with that name already exists.')
    console.error('Area request failed', error)
    return sendError(response, 500, 'Unable to save area.')
  }
}
