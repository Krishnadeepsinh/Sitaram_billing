import { createHmac, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sendError } from './http'

const COOKIE_NAME = 'sitaram_admin_session'
const SESSION_DURATION_SECONDS = 60 * 60 * 12

type SessionPayload = { username: string; expiresAt: number }

function secret() {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.')
  return value
}

function sign(value: string) {
  return createHmac('sha256', secret()).update(value).digest('base64url')
}

function cookies(request: VercelRequest) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((value) => value.trim().split('=').map(decodeURIComponent)).filter(([key]) => key))
}

export function setSession(response: VercelResponse, username: string) {
  const payload = Buffer.from(JSON.stringify({ username, expiresAt: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS } satisfies SessionPayload)).toString('base64url')
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=${payload}.${sign(payload)}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${SESSION_DURATION_SECONDS}`)
}

export function clearSession(response: VercelResponse) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`)
}

export function requireSession(request: VercelRequest, response: VercelResponse): SessionPayload | undefined {
  const token = cookies(request)[COOKIE_NAME]
  if (!token) { sendError(response, 401, 'Please sign in.'); return undefined }
  const [payload, signature] = token.split('.')
  if (!payload || !signature) { sendError(response, 401, 'Invalid session.'); return undefined }
  const expected = sign(payload)
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) { sendError(response, 401, 'Invalid session.'); return undefined }
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionPayload
    if (!session.username || session.expiresAt <= Math.floor(Date.now() / 1000)) { sendError(response, 401, 'Session expired.'); return undefined }
    return session
  } catch { sendError(response, 401, 'Invalid session.'); return undefined }
}
