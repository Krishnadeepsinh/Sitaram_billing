import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { database } from '../lib/db.js'
import { methodNotAllowed, sendError } from '../lib/http.js'
import { requireSession } from '../lib/session.js'
import { body } from '../lib/validation.js'

const logoUrlSchema = z.string().url().refine((value) => /^https:\/\//i.test(value), 'Logo URL must use HTTPS.')
const settingsSchema = z.object({ businessName: z.string().trim().min(1).max(160), address: z.string().trim().min(1).max(500), phoneNumbers: z.string().trim().min(1).max(120), upiId: z.string().trim().min(1).max(160), logoUrl: logoUrlSchema.nullable().optional() })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  try {
    const db = database()
    if (request.method === 'GET') {
      const result = await db.execute('SELECT business_name AS businessName, address, phone_numbers AS phoneNumbers, upi_id AS upiId, logo_url AS logoUrl FROM business_settings WHERE id = 1')
      return response.status(200).json(result.rows[0] ?? null)
    }
    if (request.method !== 'PUT') return methodNotAllowed(response, ['GET', 'PUT'])
    const input = body(settingsSchema, request.body)
    await db.execute({ sql: `INSERT INTO business_settings (id, business_name, address, phone_numbers, upi_id, logo_url, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET business_name = excluded.business_name, address = excluded.address, phone_numbers = excluded.phone_numbers, upi_id = excluded.upi_id, logo_url = excluded.logo_url, updated_at = excluded.updated_at`, args: [input.businessName, input.address, input.phoneNumbers, input.upiId, input.logoUrl ?? null, new Date().toISOString()] })
    return response.status(204).end()
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide valid business details.')
    console.error('Settings request failed', error)
    return sendError(response, 500, 'Unable to save business settings.')
  }
}
