import type { VercelRequest, VercelResponse } from '@vercel/node'
import { database } from './_lib/db'
import { methodNotAllowed, sendError } from './_lib/http'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  try {
    await database().execute('SELECT 1')
    return response.status(200).json({ status: 'ok', storage: process.env.TURSO_DATABASE_URL?.startsWith('file:') ? 'local' : 'cloud' })
  } catch (error) {
    console.error('Health check failed', error)
    return sendError(response, 503, 'Database unavailable.')
  }
}
