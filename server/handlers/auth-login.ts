import bcrypt from 'bcryptjs'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { database } from '../lib/db.js'
import { methodNotAllowed, sendError } from '../lib/http.js'
import { setSession } from '../lib/session.js'
import { body } from '../lib/validation.js'

const loginSchema = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  try {
    const input = body(loginSchema, request.body)
    const key = String(request.headers['x-forwarded-for'] ?? request.socket?.remoteAddress ?? 'unknown').split(',')[0].trim().slice(0, 120)
    const now = Math.floor(Date.now() / 1000); const windowSeconds = 15 * 60
    const attempt = await database().execute({ sql: 'SELECT failed_count, window_started, blocked_until FROM login_attempts WHERE attempt_key = ?', args: [key] })
    if (Number(attempt.rows[0]?.blocked_until ?? 0) > now) { response.setHeader('Retry-After', String(Number(attempt.rows[0].blocked_until) - now)); return sendError(response, 429, 'Too many sign-in attempts. Try again later.') }
    const result = await database().execute({ sql: 'SELECT username, password_hash FROM admin_auth WHERE username = ? LIMIT 1', args: [input.username] })
    const admin = result.rows[0]; const valid = Boolean(admin && await bcrypt.compare(input.password, String(admin.password_hash)))
    if (!valid) {
      const windowStarted = Number(attempt.rows[0]?.window_started ?? 0); const previous = now - windowStarted < windowSeconds ? Number(attempt.rows[0]?.failed_count ?? 0) : 0; const failures = previous + 1; const blockedUntil = failures >= 5 ? now + windowSeconds : 0
      await database().execute({ sql: `INSERT INTO login_attempts (attempt_key, failed_count, window_started, blocked_until) VALUES (?, ?, ?, ?)
        ON CONFLICT(attempt_key) DO UPDATE SET failed_count = excluded.failed_count, window_started = excluded.window_started, blocked_until = excluded.blocked_until`, args: [key, failures, previous ? windowStarted : now, blockedUntil] })
      return sendError(response, 401, 'Invalid username or password. Check both fields and try again.')
    }
    await database().execute({ sql: 'DELETE FROM login_attempts WHERE attempt_key = ?', args: [key] })
    await database().execute({ sql: 'DELETE FROM admin_sessions WHERE expires_at <= ?', args: [now] })
    await setSession(response, String(admin.username))
    return response.status(200).json({ username: String(admin.username) })
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Enter a valid username and password.')
    console.error('Login failed', error)
    return sendError(response, 500, 'Unable to sign in right now. Try again in a moment.')
  }
}
