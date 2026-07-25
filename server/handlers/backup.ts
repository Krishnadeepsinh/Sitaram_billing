import type { VercelRequest, VercelResponse } from '@vercel/node'
import { database } from '../lib/db.js'
import { methodNotAllowed, sendError } from '../lib/http.js'
import { requireSession } from '../lib/session.js'

const tables = ['business_settings', 'areas', 'plans', 'customers', 'customer_status_history', 'customer_plan_history', 'customer_plan_gaps', 'invoices', 'invoice_charges', 'invoice_merge_items', 'payments', 'payment_allocations', 'payment_charge_allocations', 'expenses', 'audit_events', 'id_sequences'] as const

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  try {
    const transaction = await database().transaction('read')
    const results: Array<readonly [string, unknown]> = []
    try {
      for (const table of tables) results.push([table, (await transaction.execute(`SELECT * FROM ${table}`)).rows] as const)
      await transaction.commit()
    } finally {
      transaction.close()
    }
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Disposition', `attachment; filename="sitaram-backup-${new Date().toISOString().slice(0, 10)}.json"`)
    return response.status(200).json({ exportedAt: new Date().toISOString(), version: 3, data: Object.fromEntries(results) })
  } catch (error) {
    console.error('Backup export failed', error)
    return sendError(response, 500, 'Unable to create backup.')
  }
}
