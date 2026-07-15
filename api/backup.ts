import type { VercelRequest, VercelResponse } from '@vercel/node'
import { database } from './_lib/db'
import { methodNotAllowed, sendError } from './_lib/http'
import { requireSession } from './_lib/session'

const tables = ['business_settings', 'areas', 'plans', 'customers', 'invoices', 'invoice_charges', 'invoice_merge_items', 'payments', 'payment_allocations', 'expenses', 'id_sequences'] as const

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  try {
    const db = database()
    const results = await Promise.all(tables.map(async (table) => [table, (await db.execute(`SELECT * FROM ${table}`)).rows] as const))
    response.setHeader('Content-Disposition', `attachment; filename="sitaram-backup-${new Date().toISOString().slice(0, 10)}.json"`)
    return response.status(200).json({ exportedAt: new Date().toISOString(), version: 1, data: Object.fromEntries(results) })
  } catch (error) {
    console.error('Backup export failed', error)
    return sendError(response, 500, 'Unable to create backup.')
  }
}
