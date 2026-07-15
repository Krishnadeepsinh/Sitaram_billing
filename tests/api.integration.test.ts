import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import invoiceHandler from '../api/invoices/index'
import paymentHandler from '../api/payments/index'
import planHandler from '../api/plans/index'
import reportHandler from '../api/reports/index'
import customerHandler from '../api/customers/index'
import { closeDatabase, database } from '../api/_lib/db'
import { setSession } from '../api/_lib/session'
import { readFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

class ResponseMock {
  statusCode = 200; body: unknown; headers = new Map<string, string | number | readonly string[]>()
  status(code: number) { this.statusCode = code; return this }
  json(value: unknown) { this.body = value; return this }
  end() { return this }
  setHeader(name: string, value: string | number | readonly string[]) { this.headers.set(name, value); return this }
}

function request(method: string, cookie: string, body?: unknown, query: Record<string, string> = {}) {
  return { method, body, query, headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } } as unknown as VercelRequest
}

describe('financial API flow', () => {
  let cookie = ''; const file = join(tmpdir(), `sitaram-api-${crypto.randomUUID()}.db`)
  beforeAll(async () => {
    process.env.TURSO_DATABASE_URL = `file:${file}`; process.env.SESSION_SECRET = 'integration-test-secret-with-32-characters'
    await database().executeMultiple(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
    const auth = new ResponseMock(); setSession(auth as unknown as VercelResponse, 'admin'); cookie = String(auth.headers.get('Set-Cookie')).split(';')[0]
    const now = new Date().toISOString()
    await database().execute({ sql: "INSERT INTO areas (id, service_type, display_name, normalized_key, sort_order, created_at) VALUES (1, 'cable', 'Main', 'main', 1, ?)", args: [now] })
    await database().execute({ sql: "INSERT INTO plans (id, service_type, name, price_paise, sort_order, created_at) VALUES (1, 'cable', 'Prime', 10000, 1, ?)", args: [now] })
    await database().execute({ sql: "INSERT INTO customers (id, customer_code, service_type, name, area_id, plan_id, installation_date, next_billing_start_date, sort_order, created_at) VALUES (1, 'CUST-001', 'cable', 'Test Customer', 1, 1, '2026-01-01', '2026-01-01', 1, ?)", args: [now] })
  })
  afterAll(async () => { closeDatabase(); await new Promise((resolve) => setTimeout(resolve, 50)); await rm(file, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined) })

  it('cascades invoice deletion and independently reverses mistaken payments', async () => {
    const invoice = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId: 1, monthsBilled: 1 }), invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(201)

    const customers = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable' }), customers as unknown as VercelResponse)
    expect(customers.body).toEqual([expect.objectContaining({ amountDuePaise: 10000, openInvoiceCount: 1, oldestDuePeriodStart: '2026-01-01', latestDuePeriodEnd: '2026-01-30' })])

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: 1, paymentDate: '2026-01-02', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(201)
    expect((await database().execute('SELECT status FROM invoices WHERE id = 1')).rows[0].status).toBe('paid')

    const deleted = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: '1' }), deleted as unknown as VercelResponse)
    expect(deleted.statusCode).toBe(204)
    expect((await database().execute('SELECT is_deleted FROM invoices WHERE id = 1')).rows[0].is_deleted).toBe(1)
    expect((await database().execute('SELECT is_deleted FROM payments WHERE id = 1')).rows[0].is_deleted).toBe(1)
    expect((await database().execute('SELECT next_billing_start_date FROM customers WHERE id = 1')).rows[0].next_billing_start_date).toBe('2026-01-01')

    const replacementInvoice = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId: 1, monthsBilled: 1 }), replacementInvoice as unknown as VercelResponse)
    expect(replacementInvoice.statusCode).toBe(201)
    const mistakenPayment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: 1, paymentDate: '2026-01-03', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash' }), mistakenPayment as unknown as VercelResponse)
    expect(mistakenPayment.statusCode).toBe(201)
    expect((await database().execute('SELECT status FROM invoices WHERE id = 2')).rows[0].status).toBe('paid')
    const reversed = new ResponseMock()
    await paymentHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: '2' }), reversed as unknown as VercelResponse)
    expect(reversed.statusCode).toBe(204)
    expect((await database().execute('SELECT is_deleted FROM payments WHERE id = 2')).rows[0].is_deleted).toBe(1)
    expect((await database().execute('SELECT status, is_deleted FROM invoices WHERE id = 2')).rows[0]).toMatchObject({ status: 'unpaid', is_deleted: 0 })

    const cleanupInvoice = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: '2' }), cleanupInvoice as unknown as VercelResponse)
    expect(cleanupInvoice.statusCode).toBe(204)

    const deactivate = new ResponseMock()
    await customerHandler(request('PUT', cookie, { id: 1, serviceType: 'cable', name: 'Test Customer', areaId: 1, planId: 1, installationDate: '2026-01-01', status: 'inactive' }), deactivate as unknown as VercelResponse)
    expect(deactivate.statusCode).toBe(204)
    const reactivate = new ResponseMock()
    await customerHandler(request('PUT', cookie, { id: 1, serviceType: 'cable', name: 'Test Customer', areaId: 1, planId: 1, installationDate: '2026-01-01', status: 'active', restartDate: '2026-02-01' }), reactivate as unknown as VercelResponse)
    expect(reactivate.statusCode).toBe(204)
    expect((await database().execute('SELECT status, next_billing_start_date FROM customers WHERE id = 1')).rows[0]).toMatchObject({ status: 'active', next_billing_start_date: '2026-02-01' })
  })

  it('rejects duplicate plan names within a service', async () => {
    const duplicate = new ResponseMock()
    await planHandler(request('POST', cookie, { serviceType: 'cable', name: ' prime ', pricePaise: 12000, units: '' }), duplicate as unknown as VercelResponse)
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.body).toEqual({ error: 'A plan with this name already exists. Edit the existing plan instead.' })
    expect(Number((await database().execute("SELECT COUNT(*) AS count FROM plans WHERE service_type = 'cable'")).rows[0].count)).toBe(1)
  })

  it('rejects a reversed reporting date range', async () => {
    const report = new ResponseMock()
    await reportHandler(request('GET', cookie, undefined, { serviceType: 'cable', from: '2026-02-01', to: '2026-01-01' }), report as unknown as VercelResponse)
    expect(report.statusCode).toBe(400)
    expect(report.body).toEqual({ error: 'The From date must be on or before the To date.' })
  })
})
