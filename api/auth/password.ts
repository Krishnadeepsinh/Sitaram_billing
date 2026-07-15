import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body } from '../_lib/validation'

const inputSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const session = requireSession(request, response)
  if (!session) return
  if (request.method !== 'PUT') return methodNotAllowed(response, ['PUT'])
  try {
    const input = body(inputSchema, request.body)
    const user = await database().execute({ sql: 'SELECT password_hash FROM admin_auth WHERE username = ?', args: [session.username] })
    if (!user.rows[0] || !await bcrypt.compare(input.currentPassword, String(user.rows[0].password_hash))) return sendError(response, 400, 'Current password is incorrect.')
    await database().execute({ sql: 'UPDATE admin_auth SET password_hash = ? WHERE username = ?', args: [await bcrypt.hash(input.newPassword, 12), session.username] })
    return response.status(204).end()
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'New password must contain at least 12 characters.')
    console.error('Password update failed', error)
    return sendError(response, 500, 'Unable to update password.')
  }
}
