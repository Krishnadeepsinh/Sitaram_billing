import type { VercelRequest, VercelResponse } from '@vercel/node'
import { methodNotAllowed } from '../lib/http.js'
import { requireSession } from '../lib/session.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  const session = await requireSession(request, response)
  if (!session) return
  return response.status(200).json({ username: session.username })
}
