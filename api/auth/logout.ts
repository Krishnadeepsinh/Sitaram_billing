import type { VercelRequest, VercelResponse } from '@vercel/node'
import { methodNotAllowed } from '../_lib/http'
import { clearSession } from '../_lib/session'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  clearSession(response)
  return response.status(204).end()
}
