import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  try {
    const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%'
    const entityType = ['customer', 'invoice', 'payment', 'expense', 'plan'].includes(String(request.query.entityType)) ? String(request.query.entityType) : null
    const limit = request.query.limit ? z.coerce.number().int().min(1).max(100).parse(request.query.limit) : 25
    const offset = request.query.offset ? z.coerce.number().int().nonnegative().parse(request.query.offset) : 0
    const db = database()
    const args = [entityType, entityType, query, query, query, limit, offset]
    const result = await db.execute({ sql: `SELECT id, entity_type AS entityType, entity_id AS entityId, action, reason, details_json AS detailsJson, created_by AS createdBy, created_at AS createdAt
      FROM audit_events WHERE (? IS NULL OR entity_type = ?) AND (action LIKE ? OR COALESCE(reason, '') LIKE ? OR details_json LIKE ?)
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, args })
    const count = await db.execute({ sql: `SELECT COUNT(*) AS value FROM audit_events WHERE (? IS NULL OR entity_type = ?) AND (action LIKE ? OR COALESCE(reason, '') LIKE ? OR details_json LIKE ?)`, args: args.slice(0, 5) })
    return response.status(200).json({ items: result.rows.map((row) => ({ ...row, details: JSON.parse(String(row.detailsJson || '{}')) })), total: Number(count.rows[0].value), limit, offset })
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Invalid audit log pagination.')
    console.error('Audit log query failed', error)
    return sendError(response, 500, 'Unable to load audit history.')
  }
}
