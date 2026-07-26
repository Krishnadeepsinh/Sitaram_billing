import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import paymentHandler from '../server/handlers/payments'
import { closeDatabase, database } from '../server/lib/db'
import { setSession } from '../server/lib/session'

class ResponseMock {
  statusCode = 200
  body: unknown
  headers = new Map<string, string>()
  status(code: number) { this.statusCode = code; return this }
  json(value: unknown) { this.body = value; return this }
  end() { return this }
  setHeader(name: string, value: string) { this.headers.set(name, value); return this }
}

function request(cookie: string, body: unknown, query: Record<string, string> = {}) {
  return { method: 'POST', body, query, headers: { cookie, 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as VercelRequest
}

describe('manual payment references', () => {
  const file = join(tmpdir(), `sitaram-payment-reference-${crypto.randomUUID()}.db`)
  let cookie = ''
  beforeAll(async () => {
    process.env.TURSO_DATABASE_URL = `file:${file}`
    process.env.SESSION_SECRET = 'payment-reference-test-secret-with-32-characters'
    await database().executeMultiple(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
    const now = new Date().toISOString()
    await database().execute({ sql: "INSERT INTO areas (id, service_type, display_name, normalized_key, sort_order, created_at) VALUES (1, 'cable', 'Main', 'main', 1, ?)", args: [now] })
    await database().execute({ sql: "INSERT INTO customers (id, customer_code, service_type, name, area_id, sort_order, created_at) VALUES (1, 'CUST-REF', 'cable', 'Reference Customer', 1, 1, ?)", args: [now] })
    const auth = new ResponseMock()
    await database().execute({ sql: "INSERT INTO admin_auth (id, username, password_hash, created_at) VALUES (1, 'admin', ?, ?)", args: [await bcrypt.hash('test', 4), now] })
    await setSession(auth as unknown as VercelResponse, 'admin')
    cookie = String(auth.headers.get('Set-Cookie')).split(';')[0]
  })
  afterAll(async () => { closeDatabase(); await rm(file, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined) })

  it('records a reference, returns it, and blocks a duplicate case-insensitively', async () => {
    const first = new ResponseMock()
    await paymentHandler(request(cookie, { serviceType: 'cable', customerId: 1, paymentDate: '2026-07-26', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'upi', paymentReference: 'UTR-ABC-100', requestKey: 'reference-first' }), first as unknown as VercelResponse)
    expect(first.statusCode).toBe(201)
    const paymentId = Number((await database().execute("SELECT id FROM payments WHERE payment_reference = 'UTR-ABC-100'")).rows[0].id)
    const detail = new ResponseMock()
    await paymentHandler({ ...request(cookie, undefined, { serviceType: 'cable', id: String(paymentId) }), method: 'GET' } as unknown as VercelRequest, detail as unknown as VercelResponse)
    expect(detail.body).toEqual(expect.objectContaining({ paymentReference: 'UTR-ABC-100' }))
    const duplicate = new ResponseMock()
    await paymentHandler(request(cookie, { serviceType: 'cable', customerId: 1, paymentDate: '2026-07-26', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'upi', paymentReference: 'utr-abc-100', requestKey: 'reference-duplicate' }), duplicate as unknown as VercelResponse)
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/already belongs|already recorded/i) }))
  })
})
