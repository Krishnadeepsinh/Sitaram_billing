import type { VercelRequest, VercelResponse } from '@vercel/node'
import { methodNotAllowed } from '../lib/http.js'
import { clearSession } from '../lib/session.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  await clearSession(request, response)
  return response.status(204).end()
}
