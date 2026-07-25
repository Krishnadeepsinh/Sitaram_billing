import type { VercelResponse } from '@vercel/node'

export function sendError(response: VercelResponse, status: number, message: string) {
  return response.status(status).json({ error: message })
}

export function methodNotAllowed(response: VercelResponse, allowed: string[]) {
  response.setHeader('Allow', allowed.join(', '))
  return sendError(response, 405, 'Method not allowed.')
}
