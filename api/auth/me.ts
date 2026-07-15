import type { VercelRequest, VercelResponse } from '@vercel/node'
import { methodNotAllowed } from '../_lib/http'
import { requireSession } from '../_lib/session'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  const session = requireSession(request, response)
  if (!session) return
  return response.status(200).json({ username: session.username })
}
