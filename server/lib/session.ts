import { createHash, randomBytes } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { database } from './db.js'
import { sendError } from './http.js'

const COOKIE_NAME = 'sitaram_admin_session'
const SESSION_DURATION_SECONDS = 60 * 60 * 12

type SessionPayload = { username: string; expiresAt: number; tokenHash: string }

function cookies(request: VercelRequest) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((value) => value.trim().split('=').map(decodeURIComponent)).filter(([key]) => key))
}

function hash(token: string) {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.')
  return createHash('sha256').update(token).update(secret).digest('hex')
}

export async function setSession(response: VercelResponse, username: string) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS
  await database().execute({ sql: 'INSERT INTO admin_sessions (token_hash, username, expires_at, created_at) VALUES (?, ?, ?, ?)', args: [hash(token), username, expiresAt, new Date().toISOString()] })
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${SESSION_DURATION_SECONDS}`)
}

export async function clearSession(request: VercelRequest, response: VercelResponse) {
  const token = cookies(request)[COOKIE_NAME]
  if (token) await database().execute({ sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', args: [hash(token)] })
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`)
}

export async function requireSession(request: VercelRequest, response: VercelResponse): Promise<SessionPayload | undefined> {
  response.setHeader('Cache-Control', 'no-store')
  const token = cookies(request)[COOKIE_NAME]
  if (!token) { sendError(response, 401, 'Please sign in.'); return undefined }
  const tokenHash = hash(token)
  const result = await database().execute({ sql: 'SELECT username, expires_at AS expiresAt FROM admin_sessions WHERE token_hash = ?', args: [tokenHash] })
  const row = result.rows[0]
  if (!row || Number(row.expiresAt) <= Math.floor(Date.now() / 1000)) {
    if (row) await database().execute({ sql: 'DELETE FROM admin_sessions WHERE token_hash = ?', args: [tokenHash] })
    sendError(response, 401, 'Session expired. Please sign in again.')
    return undefined
  }
  return { username: String(row.username), expiresAt: Number(row.expiresAt), tokenHash }
}
