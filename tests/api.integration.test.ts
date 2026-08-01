import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import invoiceHandler from '../server/handlers/invoices'
import bulkInvoiceHandler from '../server/handlers/invoices-bulk'
import mergeInvoiceHandler from '../server/handlers/invoices-merge'
import paymentHandler from '../server/handlers/payments'
import planHandler from '../server/handlers/plans'
import reportHandler from '../server/handlers/reports'
import customerHandler from '../server/handlers/customers'
import expenseHandler from '../server/handlers/expenses'
import backupHandler from '../server/handlers/backup'
import areaHandler from '../server/handlers/areas'
import settingsHandler from '../server/handlers/settings'
import loginHandler from '../server/handlers/auth-login'
import logoutHandler from '../server/handlers/auth-logout'
import passwordHandler from '../server/handlers/auth-password'
import { closeDatabase, database } from '../server/lib/db'
import { setSession } from '../server/lib/session'
import { readFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addBillingDays, todayInBusinessTimezone } from '../src/lib/date'

class ResponseMock {
  statusCode = 200; body: unknown; headers = new Map<string, string | number | readonly string[]>()
  status(code: number) { this.statusCode = code; return this }
  json(value: unknown) { this.body = value; return this }
  end() { return this }
  setHeader(name: string, value: string | number | readonly string[]) { this.headers.set(name, value); return this }
}

function request(method: string, cookie: string, body?: unknown, query: Record<string, string> = {}, ip = '127.0.0.1') {
  return { method, body, query, headers: { cookie, 'x-forwarded-for': ip }, socket: { remoteAddress: ip } } as unknown as VercelRequest
}

async function invoiceRequest(cookie: string, customerId: number, monthsBilled = 1) {
  const customer = await database().execute({ sql: 'SELECT next_billing_start_date FROM customers WHERE id = ?', args: [customerId] })
  return request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled, expectedPeriodStart: String(customer.rows[0].next_billing_start_date) })
}

describe('financial API flow', () => {
  let cookie = ''; const file = join(tmpdir(), `sitaram-api-${crypto.randomUUID()}.db`)
  beforeAll(async () => {
    process.env.TURSO_DATABASE_URL = `file:${file}`; process.env.SESSION_SECRET = 'integration-test-secret-with-32-characters'
    await database().executeMultiple(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
    const auth = new ResponseMock()
    const now = new Date().toISOString()
    await database().execute({ sql: "INSERT INTO areas (id, service_type, display_name, normalized_key, sort_order, created_at) VALUES (1, 'cable', 'Main', 'main', 1, ?)", args: [now] })
    await database().execute({ sql: "INSERT INTO plans (id, service_type, name, price_paise, sort_order, created_at) VALUES (1, 'cable', 'Prime', 10000, 1, ?)", args: [now] })
    await database().execute({ sql: "INSERT INTO customers (id, customer_code, service_type, name, area_id, plan_id, installation_date, next_billing_start_date, sort_order, created_at) VALUES (1, 'CUST-001', 'cable', 'Test Customer', 1, 1, '2026-01-01', '2026-01-01', 1, ?)", args: [now] })
    await database().execute("INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES ('customer', 'cable', 1)")
    await database().execute({ sql: "INSERT INTO admin_auth (id, username, password_hash, created_at) VALUES (1, 'admin', ?, ?)", args: [await bcrypt.hash('OriginalPass123', 4), now] })
    await setSession(auth as unknown as VercelResponse, 'admin'); cookie = String(auth.headers.get('Set-Cookie')).split(';')[0]
  })
  afterAll(async () => { closeDatabase(); await new Promise((resolve) => setTimeout(resolve, 50)); await rm(file, { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined) })

  it('cascades invoice deletion and independently reverses mistaken payments', async () => {
    const invoice = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, 1), invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(201)

    const customers = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable' }), customers as unknown as VercelResponse)
    expect((customers.body as { items: unknown[] }).items).toEqual([expect.objectContaining({ sortOrder: 1, amountDuePaise: 10000, openInvoiceCount: 1, oldestDuePeriodStart: '2026-01-01', latestDuePeriodEnd: '2026-01-30' })])

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: 1, paymentDate: '2026-01-02', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'delete-cascade-payment' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(201)
    expect((await database().execute('SELECT status FROM invoices WHERE id = 1')).rows[0].status).toBe('paid')

    const deleted = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: '1' }), deleted as unknown as VercelResponse)
    expect(deleted.statusCode).toBe(204)
    expect((await database().execute('SELECT is_deleted FROM invoices WHERE id = 1')).rows[0].is_deleted).toBe(1)
    expect((await database().execute('SELECT is_deleted FROM payments WHERE id = 1')).rows[0].is_deleted).toBe(1)
    expect((await database().execute('SELECT next_billing_start_date FROM customers WHERE id = 1')).rows[0].next_billing_start_date).toBe('2026-01-01')

    const replacementInvoice = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, 1), replacementInvoice as unknown as VercelResponse)
    expect(replacementInvoice.statusCode).toBe(201)
    const mistakenPayment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: 1, paymentDate: '2026-01-03', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'mistaken-payment' }), mistakenPayment as unknown as VercelResponse)
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

  it('deletes an older renewal while preserving later coverage', async () => {
    const installationDate = todayInBusinessTimezone()
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Historical Correction', areaId: 1, planId: 1, installationDate, openingBalancePaise: 100000, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    expect(created.statusCode).toBe(201)
    const customerId = Number((created.body as { id: number }).id)

    const first = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), first as unknown as VercelResponse)
    expect(first.statusCode).toBe(201)
    const firstId = Number((first.body as { invoiceId: number }).invoiceId)
    const second = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), second as unknown as VercelResponse)
    expect(second.statusCode).toBe(201)
    const secondId = Number((second.body as { invoiceId: number }).invoiceId)

    const deleted = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(firstId), reason: 'Incorrect first renewal' }), deleted as unknown as VercelResponse)

    expect(deleted.statusCode).toBe(204)
    expect((await database().execute({ sql: 'SELECT id, is_deleted FROM invoices WHERE id IN (?, ?) ORDER BY id', args: [firstId, secondId] })).rows).toEqual([
      expect.objectContaining({ id: firstId, is_deleted: 1 }),
      expect.objectContaining({ id: secondId, is_deleted: 0 }),
    ])
    expect((await database().execute({ sql: 'SELECT charge_type, amount_paise FROM invoice_charges WHERE invoice_id = ? ORDER BY charge_type', args: [secondId] })).rows).toEqual([
      expect.objectContaining({ charge_type: 'opening_due', amount_paise: 100000 }),
      expect.objectContaining({ charge_type: 'service', amount_paise: 10000 }),
    ])
    expect((await database().execute({ sql: 'SELECT previous_due_snapshot_paise, total_payable_paise FROM invoices WHERE id = ?', args: [secondId] })).rows[0]).toMatchObject({ previous_due_snapshot_paise: 100000, total_payable_paise: 110000 })
    const customers = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: 'Historical Correction' }), customers as unknown as VercelResponse)
    expect((customers.body as { items: unknown[] }).items).toEqual([expect.objectContaining({ amountDuePaise: 110000, previousDuePaise: 100000, futurePlanDuePaise: 10000, unbilledOpeningDuePaise: 0 })])
    expect((await database().execute({ sql: 'SELECT next_billing_start_date FROM customers WHERE id = ?', args: [customerId] })).rows[0].next_billing_start_date).toBe(addBillingDays(installationDate, 60))
  })

  it('allows a future service start while keeping invoice date independently editable', async () => {
    const created = new ResponseMock()
    const installationDate = todayInBusinessTimezone()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Scheduled Start', areaId: 1, planId: 1, installationDate, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const invoice = new ResponseMock()
    const serviceStart = addBillingDays(installationDate, 30)
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: installationDate, periodStart: serviceStart, issuedDate: addBillingDays(installationDate, -1) }), invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(201)
    const invoiceId = Number((invoice.body as { invoiceId: number }).invoiceId)
    expect((await database().execute({ sql: 'SELECT period_start, issued_date FROM invoices WHERE id = ?', args: [invoiceId] })).rows[0]).toMatchObject({ period_start: serviceStart, issued_date: addBillingDays(installationDate, -1) })
  })

  it('fills a missed previous period without moving or duplicating the normal renewal position', async () => {
    const today = todayInBusinessTimezone()
    const installationDate = addBillingDays(today, -90)
    const missedPeriodStart = installationDate
    const laterPeriodStart = addBillingDays(installationDate, 30)
    const nextAfterLaterPeriod = addBillingDays(laterPeriodStart, 30)
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Missed Period Recovery', areaId: 1, planId: 1, installationDate, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)

    const laterInvoice = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: today, periodStart: laterPeriodStart }), laterInvoice as unknown as VercelResponse)
    expect(laterInvoice.statusCode).toBe(201)

    const blockedNormalBackdate = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: nextAfterLaterPeriod, periodStart: missedPeriodStart }), blockedNormalBackdate as unknown as VercelResponse)
    expect(blockedNormalBackdate.statusCode).toBe(409)
    expect(blockedNormalBackdate.body).toEqual({ error: expect.stringContaining('Use Bill Missed Dates') })

    const preview = new ResponseMock()
    await invoiceHandler(request('GET', cookie, undefined, { serviceType: 'cable', previewCustomerId: String(customerId), monthsBilled: '1', periodStart: missedPeriodStart, billingMode: 'historical' }), preview as unknown as VercelResponse)
    expect(preview.statusCode).toBe(200)
    expect(preview.body).toEqual(expect.objectContaining({ planName: 'Prime', conflict: null, nextEligibleDate: nextAfterLaterPeriod }))

    const missedInvoiceBody = { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: nextAfterLaterPeriod, periodStart: missedPeriodStart, billingMode: 'historical', historicalReason: 'Previous service period was recorded late' }
    const missedInvoice = new ResponseMock()
    await invoiceHandler(request('POST', cookie, missedInvoiceBody), missedInvoice as unknown as VercelResponse)
    expect(missedInvoice.statusCode).toBe(201)
    expect((await database().execute({ sql: 'SELECT billing_mode, historical_reason, period_start, period_end FROM invoices WHERE id = ?', args: [(missedInvoice.body as { invoiceId: number }).invoiceId] })).rows[0]).toMatchObject({
      billing_mode: 'historical',
      historical_reason: 'Previous service period was recorded late',
      period_start: missedPeriodStart,
      period_end: addBillingDays(missedPeriodStart, 29),
    })
    expect((await database().execute({ sql: 'SELECT next_billing_start_date FROM customers WHERE id = ?', args: [customerId] })).rows[0].next_billing_start_date).toBe(nextAfterLaterPeriod)

    const replay = new ResponseMock()
    await invoiceHandler(request('POST', cookie, missedInvoiceBody), replay as unknown as VercelResponse)
    expect(replay.statusCode).toBe(200)
    expect(replay.body).toEqual(expect.objectContaining({ replayed: true, invoiceCode: (missedInvoice.body as { invoiceCode: string }).invoiceCode }))

    const overlap = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { ...missedInvoiceBody, periodStart: addBillingDays(missedPeriodStart, 1), historicalReason: 'Attempted duplicate missed period' }), overlap as unknown as VercelResponse)
    expect(overlap.statusCode).toBe(409)
    expect(overlap.body).toEqual({ error: expect.stringContaining('already covers') })
  })

  it('keeps renewals continuous after billing starts', async () => {
    const installationDate = todayInBusinessTimezone()
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Continuous Renewal', areaId: 1, planId: 1, installationDate, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    const nextStart = addBillingDays(installationDate, 30)
    const skippedStart = addBillingDays(nextStart, 30)
    const skipped = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: nextStart, periodStart: skippedStart }), skipped as unknown as VercelResponse)
    expect(skipped.statusCode).toBe(409)
    expect(skipped.body).toEqual({ error: expect.stringContaining('no service dates are skipped') })
    expect(Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ? AND is_deleted = 0', args: [customerId] })).rows[0].count)).toBe(1)
    expect((await database().execute({ sql: 'SELECT next_billing_start_date AS nextStart FROM customers WHERE id = ?', args: [customerId] })).rows[0].nextStart).toBe(nextStart)
  })

  it('rejects an entire multi-cycle invoice when any paid or unpaid period is already billed', async () => {
    const installationDate = addBillingDays(todayInBusinessTimezone(), -120)
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Atomic Overlap Check', areaId: 1, planId: 1, installationDate, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await database().execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [installationDate, customerId] })
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'atomic-overlap-payment' }), new ResponseMock() as unknown as VercelResponse)
    const nextStart = addBillingDays(installationDate, 60)
    for (const [periodStart, expectedStatus] of [[installationDate, 'paid'], [addBillingDays(installationDate, 30), 'unpaid']] as const) {
      const blocked = new ResponseMock()
      await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 2, expectedPeriodStart: nextStart, periodStart, billingMode: 'historical', historicalReason: 'QA verifies all-or-nothing overlap handling' }), blocked as unknown as VercelResponse)
      expect(blocked.statusCode).toBe(409)
      expect(blocked.body).toEqual({ error: expect.stringContaining(`(${expectedStatus}) already covers`) })
      expect((blocked.body as { error: string }).error).toContain('No invoice was created')
    }
    expect(Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ? AND is_deleted = 0', args: [customerId] })).rows[0].count)).toBe(2)
    expect((await database().execute({ sql: 'SELECT next_billing_start_date AS nextStart FROM customers WHERE id = ?', args: [customerId] })).rows[0].nextStart).toBe(nextStart)
  })

  it('reports exact legacy gaps and deactivates service automatically after coverage ends', async () => {
    const today = todayInBusinessTimezone()
    const expiredInstallation = addBillingDays(today, -30)
    const expired = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Recharge Due Service', areaId: 1, planId: 1, installationDate: expiredInstallation, openingBalancePaise: 0, openingBalanceType: 'due' }), expired as unknown as VercelResponse)
    const expiredId = Number((expired.body as { id: number }).id)
    const expiredCode = String((expired.body as { customerCode: string }).customerCode)
    await database().execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [expiredInstallation, expiredId] })
    await invoiceHandler(await invoiceRequest(cookie, expiredId), new ResponseMock() as unknown as VercelResponse)
    const expiredList = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: expiredCode }), expiredList as unknown as VercelResponse)
    expect((expiredList.body as { items: unknown[] }).items).toEqual([expect.objectContaining({ status: 'active', coverageStatus: 'expired', serviceStatus: 'recharge_due' })])

    const legacyInstallation = addBillingDays(today, -31)
    const legacy = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Legacy Gap Dates', areaId: 1, planId: 1, installationDate: legacyInstallation, openingBalancePaise: 0, openingBalanceType: 'due' }), legacy as unknown as VercelResponse)
    const legacyId = Number((legacy.body as { id: number }).id)
    const legacyCode = String((legacy.body as { customerCode: string }).customerCode)
    await database().execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [legacyInstallation, legacyId] })
    await invoiceHandler(await invoiceRequest(cookie, legacyId), new ResponseMock() as unknown as VercelResponse)
    const futureStart = addBillingDays(today, 31)
    await database().execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [futureStart, legacyId] })
    await invoiceHandler(await invoiceRequest(cookie, legacyId), new ResponseMock() as unknown as VercelResponse)
    const legacyList = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: legacyCode }), legacyList as unknown as VercelResponse)
    expect((legacyList.body as { items: unknown[] }).items).toEqual([expect.objectContaining({
      coverageStatus: 'future', serviceStatus: 'scheduled', hasHistoricalGap: 1,
      historicalGapStart: addBillingDays(today, -1), historicalGapEnd: addBillingDays(today, 30), historicalGapDays: 32,
    })])
  })

  it('restarts expired service today without billing the inactive gap', async () => {
    const today = todayInBusinessTimezone()
    const installationDate = addBillingDays(today, -90)
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Paused Then Restarted', areaId: 1, planId: 1, installationDate, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await database().execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [installationDate, customerId] })
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)

    const restartBody = { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: today, periodStart: today, billingMode: 'normal', restartService: true }
    const restarted = new ResponseMock()
    await invoiceHandler(request('POST', cookie, restartBody), restarted as unknown as VercelResponse)
    expect(restarted.statusCode).toBe(201)
    expect(restarted.body).toMatchObject({ periodStart: today, periodEnd: addBillingDays(today, 29), replayed: false })
    expect((await database().execute({ sql: 'SELECT next_billing_start_date AS nextStart FROM customers WHERE id = ?', args: [customerId] })).rows[0].nextStart).toBe(addBillingDays(today, 30))
    expect((await database().execute({ sql: 'SELECT status, effective_date AS effectiveDate FROM customer_status_history WHERE customer_id = ? ORDER BY effective_date DESC, id DESC LIMIT 2', args: [customerId] })).rows).toEqual([
      expect.objectContaining({ status: 'active', effectiveDate: today }),
      expect.objectContaining({ status: 'inactive', effectiveDate: addBillingDays(installationDate, 30) }),
    ])
    const restartedList = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: 'Paused Then Restarted' }), restartedList as unknown as VercelResponse)
    expect((restartedList.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ coverageStatus: 'active', serviceStatus: 'active', hasHistoricalGap: 0 }),
    ])

    const retry = new ResponseMock()
    await invoiceHandler(request('POST', cookie, restartBody), retry as unknown as VercelResponse)
    expect(retry.statusCode).toBe(200)
    expect(retry.body).toMatchObject({ periodStart: today, replayed: true })
  })

  it('previews bulk billing without creating financial records', async () => {
    const today = todayInBusinessTimezone()
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Bulk Preview Customer', areaId: 1, planId: 1, installationDate: today, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const throughMonth = addBillingDays(today, 60).slice(0, 7)
    const before = Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ?', args: [customerId] })).rows[0].count)

    const preview = new ResponseMock()
    await bulkInvoiceHandler(request('POST', cookie, { serviceType: 'cable', throughMonth, customerIds: [customerId], preview: true }), preview as unknown as VercelResponse)
    expect(preview.statusCode).toBe(200)
    expect(preview.body).toEqual(expect.objectContaining({ generated: [], ready: [expect.objectContaining({ customerId, customerName: 'Bulk Preview Customer', periodStart: today, cycles: expect.any(Number), amountPaise: expect.any(Number) })], failed: [] }))
    expect(Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ?', args: [customerId] })).rows[0].count)).toBe(before)
  })

  it('rejects missed periods before installation or whose full cycle has not ended', async () => {
    const today = todayInBusinessTimezone()
    const installationDate = addBillingDays(today, -60)
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Missed Period Boundaries', areaId: 1, planId: 1, installationDate, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const base = { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: today, billingMode: 'historical', historicalReason: 'Missed billing boundary check' }

    const beforeInstallation = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { ...base, periodStart: addBillingDays(installationDate, -30) }), beforeInstallation as unknown as VercelResponse)
    expect(beforeInstallation.statusCode).toBe(400)
    expect(beforeInstallation.body).toEqual({ error: expect.stringContaining('cannot start before installation') })

    const unfinishedCycle = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { ...base, periodStart: addBillingDays(today, -28) }), unfinishedCycle as unknown as VercelResponse)
    expect(unfinishedCycle.statusCode).toBe(400)
    expect(unfinishedCycle.body).toEqual({ error: expect.stringContaining('must end today or earlier') })
  })

  it('preserves a payment shared by another live invoice when one invoice is deleted', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Shared Payment Deletion', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const first = new ResponseMock(); await invoiceHandler(await invoiceRequest(cookie, customerId), first as unknown as VercelResponse)
    const second = new ResponseMock(); await invoiceHandler(await invoiceRequest(cookie, customerId), second as unknown as VercelResponse)
    const firstId = Number((first.body as { invoiceId: number }).invoiceId)
    const secondId = Number((second.body as { invoiceId: number }).invoiceId)

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 20000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: 'shared-payment-delete' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(201)
    const paymentId = Number((await database().execute({ sql: 'SELECT id FROM payments WHERE payment_code = ?', args: [(payment.body as { paymentCode: string }).paymentCode] })).rows[0].id)
    expect(Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM payment_allocations WHERE payment_id = ? AND is_deleted = 0', args: [paymentId] })).rows[0].count)).toBe(2)

    const deleted = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(firstId), reason: 'Remove duplicate invoice' }), deleted as unknown as VercelResponse)
    expect(deleted.statusCode).toBe(204)
    expect((await database().execute({ sql: 'SELECT is_deleted FROM payments WHERE id = ?', args: [paymentId] })).rows[0].is_deleted).toBe(0)
    expect((await database().execute({ sql: 'SELECT is_deleted FROM invoices WHERE id = ?', args: [secondId] })).rows[0].is_deleted).toBe(0)
    expect((await database().execute({ sql: 'SELECT status FROM invoices WHERE id = ?', args: [secondId] })).rows[0].status).toBe('paid')
    expect((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM payment_allocations WHERE payment_id = ? AND invoice_id = ? AND is_deleted = 0', args: [paymentId, secondId] })).rows[0].count).toBe(1)
  })

  it('rejects duplicate plan names within a service', async () => {
    const duplicate = new ResponseMock()
    await planHandler(request('POST', cookie, { serviceType: 'cable', name: ' prime ', pricePaise: 12000, units: '' }), duplicate as unknown as VercelResponse)
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.body).toEqual({ error: 'A plan with this name already exists. Edit the existing plan instead.' })
    expect(Number((await database().execute("SELECT COUNT(*) AS count FROM plans WHERE service_type = 'cable'")).rows[0].count)).toBe(1)
  })

  it('returns actionable customer validation errors', async () => {
    const blankName = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: '   ', areaId: 1, openingBalancePaise: 0, openingBalanceType: 'due' }), blankName as unknown as VercelResponse)
    expect(blankName.statusCode).toBe(400)
    expect(blankName.body).toEqual({ error: 'Enter a subscriber name; spaces alone are not valid.' })

    const invalidBalance = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Valid Name', areaId: 1, openingBalancePaise: -1, openingBalanceType: 'due' }), invalidBalance as unknown as VercelResponse)
    expect(invalidBalance.statusCode).toBe(400)
    expect(invalidBalance.body).toEqual({ error: 'Enter a valid non-negative opening balance.' })
  })

  it('separates previous opening due from current plan dues', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Opening Due Split', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 100000, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    expect(created.statusCode).toBe(201)
    const customerId = Number((created.body as { id: number }).id)
    const customerCode = String((created.body as { customerCode: string }).customerCode)

    const beforeInvoice = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: customerCode }), beforeInvoice as unknown as VercelResponse)
    expect(((beforeInvoice.body as { items: Array<Record<string, number>> }).items)[0]).toMatchObject({ amountDuePaise: 100000, previousDuePaise: 100000, currentPlanDuePaise: 0, futurePlanDuePaise: 0, unbilledOpeningDuePaise: 100000 })

    const preview = new ResponseMock()
    await invoiceHandler(request('GET', cookie, undefined, { serviceType: 'cable', previewCustomerId: String(customerId), monthsBilled: '1', periodStart: todayInBusinessTimezone(), billingMode: 'normal' }), preview as unknown as VercelResponse)
    expect(preview.body).toEqual(expect.objectContaining({ previousDuePaise: 100000, currentChargePaise: 10000, totalPayablePaise: 110000 }))

    const prematureDiscount = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 0, discountGivenPaise: 1000, paymentMode: 'cash', requestKey: 'opening-due-early-discount' }), prematureDiscount as unknown as VercelResponse)
    expect(prematureDiscount).toMatchObject({ statusCode: 400, body: { error: 'Discounts can settle invoiced dues only. Generate the first invoice before discounting an opening due.' } })

    const invoice = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(201)
    const invoiceId = Number((invoice.body as { invoiceId: number }).invoiceId)
    const afterInvoice = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: customerCode }), afterInvoice as unknown as VercelResponse)
    expect(((afterInvoice.body as { items: Array<Record<string, number | string>> }).items)[0]).toMatchObject({ amountDuePaise: 110000, previousDuePaise: 100000, currentPlanDuePaise: 10000, futurePlanDuePaise: 0, unbilledOpeningDuePaise: 0, duePlanPeriodStart: todayInBusinessTimezone(), duePlanCycleEndStart: todayInBusinessTimezone() })

    const futureInvoice = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), futureInvoice as unknown as VercelResponse)
    expect(futureInvoice.statusCode).toBe(201)
    const futureInvoiceId = Number((futureInvoice.body as { invoiceId: number }).invoiceId)
    const withFutureInvoice = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: customerCode }), withFutureInvoice as unknown as VercelResponse)
    expect(((withFutureInvoice.body as { items: Array<Record<string, number | string>> }).items)[0]).toMatchObject({ amountDuePaise: 120000, previousDuePaise: 100000, currentPlanDuePaise: 10000, futurePlanDuePaise: 10000, duePlanPeriodStart: todayInBusinessTimezone(), duePlanCycleEndStart: addBillingDays(todayInBusinessTimezone(), 30) })

    const deactivateCoveredCustomer = new ResponseMock()
    await customerHandler(request('PUT', cookie, { id: customerId, serviceType: 'cable', name: 'Opening Due Split', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), status: 'inactive' }), deactivateCoveredCustomer as unknown as VercelResponse)
    expect(deactivateCoveredCustomer.statusCode).toBe(409)
    expect(deactivateCoveredCustomer.body).toEqual({ error: expect.stringContaining('Deactivation is available from') })
    expect((await database().execute({ sql: 'SELECT status, next_billing_start_date AS nextBillingStartDate FROM customers WHERE id = ?', args: [customerId] })).rows[0]).toMatchObject({ status: 'active', nextBillingStartDate: addBillingDays(todayInBusinessTimezone(), 60) })

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 30000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'opening-due-split-payment' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(201)
    const afterPayment = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: customerCode }), afterPayment as unknown as VercelResponse)
    expect(((afterPayment.body as { items: Array<Record<string, number>> }).items)[0]).toMatchObject({ amountDuePaise: 90000, previousDuePaise: 70000, currentPlanDuePaise: 10000, futurePlanDuePaise: 10000 })

    const deletedFuture = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(futureInvoiceId) }), deletedFuture as unknown as VercelResponse)
    expect(deletedFuture.statusCode).toBe(204)

    const deleted = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(invoiceId) }), deleted as unknown as VercelResponse)
    expect(deleted.statusCode).toBe(204)
    const afterDelete = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: customerCode }), afterDelete as unknown as VercelResponse)
    expect(((afterDelete.body as { items: Array<Record<string, number>> }).items)[0]).toMatchObject({ amountDuePaise: 100000, previousDuePaise: 100000, currentPlanDuePaise: 0 })
    const archived = new ResponseMock()
    await customerHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(customerId), reason: 'Integration test cleanup' }), archived as unknown as VercelResponse)
    expect(archived.statusCode).toBe(204)
  })

  it('rejects a reversed reporting date range', async () => {
    const report = new ResponseMock()
    await reportHandler(request('GET', cookie, undefined, { serviceType: 'cable', from: '2026-02-01', to: '2026-01-01' }), report as unknown as VercelResponse)
    expect(report.statusCode).toBe(400)
    expect(report.body).toEqual({ error: 'The From date must be on or before the To date.' })
  })

  it('initializes billing after installation is added and searches financial records by identifiers', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Later Install', areaId: 1, phone: '', stbNumber: 'BOX-22', planId: 1, installationDate: null, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    expect(created.statusCode).toBe(201)
    const customerId = Number((created.body as { id: number }).id)
    const customerCode = String((created.body as { customerCode: string }).customerCode)

    const updated = new ResponseMock()
    await customerHandler(request('PUT', cookie, { id: customerId, serviceType: 'cable', name: 'Later Install', areaId: 1, phone: '', stbNumber: 'BOX-22', planId: 1, installationDate: '2026-05-01', status: 'active' }), updated as unknown as VercelResponse)
    expect(updated.statusCode).toBe(204)
    expect((await database().execute({ sql: 'SELECT next_billing_start_date FROM customers WHERE id = ?', args: [customerId] })).rows[0].next_billing_start_date).toBe(todayInBusinessTimezone())

    const invoice = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(201)
    const invoiceSearch = new ResponseMock()
    await invoiceHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: customerCode }), invoiceSearch as unknown as VercelResponse)
    expect(invoiceSearch.body).toEqual(expect.objectContaining({ items: [expect.objectContaining({ customerId, chargeAmountPaise: 10000 })], total: 1 }))
    const invoiceId = Number(((invoiceSearch.body as { items: Array<{ id: number }> }).items[0]).id)

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-05-02', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: 'search-payment' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(201)
    const paymentSearch = new ResponseMock()
    await paymentHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: 'BOX-22' }), paymentSearch as unknown as VercelResponse)
    expect(paymentSearch.body).toEqual(expect.objectContaining({ items: [expect.objectContaining({ customerId, settledAmountPaise: 10000 })], total: 1 }))

    const deleted = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(invoiceId) }), deleted as unknown as VercelResponse)
    expect(deleted.statusCode).toBe(204)
    expect((await database().execute({ sql: 'SELECT next_billing_start_date FROM customers WHERE id = ?', args: [customerId] })).rows[0].next_billing_start_date).toBe(todayInBusinessTimezone())
  })

  it('restores source invoices when the latest merged invoice is deleted', async () => {
    const first = new ResponseMock(); const second = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, 1), first as unknown as VercelResponse)
    await invoiceHandler(await invoiceRequest(cookie, 1), second as unknown as VercelResponse)
    expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201)
    const sourceIds = [Number((first.body as { invoiceId: number }).invoiceId), Number((second.body as { invoiceId: number }).invoiceId)]
    const before = String((await database().execute('SELECT next_billing_start_date FROM customers WHERE id = 1')).rows[0].next_billing_start_date)
    const merged = new ResponseMock()
    await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: sourceIds }), merged as unknown as VercelResponse)
    expect(merged.statusCode).toBe(201)
    const mergedId = Number((merged.body as { invoiceId: number }).invoiceId)
    const invoiceList = new ResponseMock()
    await invoiceHandler(request('GET', cookie, undefined, { serviceType: 'cable' }), invoiceList as unknown as VercelResponse)
    expect((invoiceList.body as { items: Array<{ id: number; isCombined: number }> }).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: mergedId, isCombined: 1 })]))
    const deleted = new ResponseMock()
    await invoiceHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(mergedId) }), deleted as unknown as VercelResponse)
    expect(deleted.statusCode).toBe(204)
    expect((await database().execute({ sql: `SELECT COUNT(*) AS count FROM invoices WHERE id IN (${sourceIds.map(() => '?').join(',')}) AND is_merged = 0 AND is_deleted = 0`, args: sourceIds })).rows[0].count).toBe(2)
    expect((await database().execute('SELECT next_billing_start_date FROM customers WHERE id = 1')).rows[0].next_billing_start_date).toBe(before)
  })

  it('bulk billing skips ineligible periods and validates list filters and backups', async () => {
    const bulk = new ResponseMock()
    await bulkInvoiceHandler(request('POST', cookie, { serviceType: 'cable', throughMonth: '2026-02' }), bulk as unknown as VercelResponse)
    expect(bulk.statusCode).toBe(201)
    const invalidPayments = new ResponseMock()
    await paymentHandler(request('GET', cookie, undefined, { serviceType: 'cable', from: '2026-06-02', to: '2026-06-01' }), invalidPayments as unknown as VercelResponse)
    expect(invalidPayments.statusCode).toBe(400)
    const invalidExpenses = new ResponseMock()
    await expenseHandler(request('GET', cookie, undefined, { from: '2026-06-02', to: '2026-06-01' }), invalidExpenses as unknown as VercelResponse)
    expect(invalidExpenses.statusCode).toBe(400)
    const backup = new ResponseMock()
    await backupHandler(request('GET', cookie), backup as unknown as VercelResponse)
    expect(backup.statusCode).toBe(200)
    expect(backup.headers.get('Cache-Control')).toBe('no-store')
    expect(backup.body).toEqual(expect.objectContaining({ version: 3, data: expect.objectContaining({ customers: expect.any(Array), payment_allocations: expect.any(Array), audit_events: expect.any(Array) }) }))
  })

  it('normalizes, revives, edits, and protects service areas', async () => {
    const created = new ResponseMock()
    await areaHandler(request('POST', cookie, { serviceType: 'cable', displayName: ' New   Town ' }), created as unknown as VercelResponse)
    expect(created.statusCode).toBe(201)
    const areaId = Number((created.body as { id: number }).id)
    const reused = new ResponseMock()
    await areaHandler(request('POST', cookie, { serviceType: 'cable', displayName: 'new town' }), reused as unknown as VercelResponse)
    expect(reused.body).toMatchObject({ id: areaId, reused: true })
    const renamed = new ResponseMock()
    await areaHandler(request('PUT', cookie, { id: areaId, serviceType: 'cable', displayName: 'North Zone' }), renamed as unknown as VercelResponse)
    expect(renamed.statusCode).toBe(204)
    const removed = new ResponseMock()
    await areaHandler(request('DELETE', cookie, undefined, { id: String(areaId), serviceType: 'cable' }), removed as unknown as VercelResponse)
    expect(removed.statusCode).toBe(204)
    const revived = new ResponseMock()
    await areaHandler(request('POST', cookie, { serviceType: 'cable', displayName: ' north  zone ' }), revived as unknown as VercelResponse)
    expect(revived.body).toMatchObject({ id: areaId, reused: true })
    const protectedArea = new ResponseMock()
    await areaHandler(request('DELETE', cookie, undefined, { id: '1', serviceType: 'cable' }), protectedArea as unknown as VercelResponse)
    expect(protectedArea.statusCode).toBe(409)
  })

  it('allocates cash, discount, and opening credit with full traceability', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Credit Customer', areaId: 1, stbNumber: 'CREDIT-BOX', planId: 1, installationDate: '2026-08-01', openingBalancePaise: 2000, openingBalanceType: 'advance' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const invoice = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), invoice as unknown as VercelResponse)
    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-07-02', amountReceivedPaise: 7000, discountGivenPaise: 1000, paymentMode: 'cash', notes: 'Three-source settlement', requestKey: 'three-source-settlement' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(201)
    expect(payment.body).toEqual(expect.objectContaining({ resultingStatus: 'settled', allocations: [expect.objectContaining({ cashPaise: 7000, discountPaise: 1000, creditPaise: 0 })] }))
    expect((await database().execute({ sql: "SELECT COALESCE(SUM(amount_credit_paise), 0) AS credit FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE p.customer_id = ? AND p.payment_mode = 'system_credit' AND pa.is_deleted = 0", args: [customerId] })).rows[0].credit).toBe(2000)
    expect((await database().execute({ sql: 'SELECT credit_balance_paise FROM customers WHERE id = ?', args: [customerId] })).rows[0].credit_balance_paise).toBe(0)
    const invalidDiscount = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-07-03', amountReceivedPaise: 100, discountGivenPaise: 1, paymentMode: 'cash', requestKey: 'invalid-discount' }), invalidDiscount as unknown as VercelResponse)
    expect(invalidDiscount.statusCode).toBe(400)
  })

  it('keeps overpayment cash on its original invoice and applies the remainder as future credit', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Overpayment Customer', areaId: 1, stbNumber: 'OVERPAY-BOX', planId: 1, installationDate: '2026-09-01', openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const first = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), first as unknown as VercelResponse)
    const overpayment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-07-04', amountReceivedPaise: 20000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: 'overpayment-credit' }), overpayment as unknown as VercelResponse)
    expect(overpayment.body).toEqual(expect.objectContaining({ resultingStatus: 'credit_added' }))

    const second = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, customerId), second as unknown as VercelResponse)
    const secondId = Number((second.body as { invoiceId: number }).invoiceId)
    const allocations = await database().execute({ sql: `SELECT payments.payment_mode AS paymentMode, payment_allocations.amount_cash_paise AS cashPaise, payment_allocations.amount_credit_paise AS creditPaise
      FROM payment_allocations JOIN payments ON payments.id = payment_allocations.payment_id
      WHERE payment_allocations.invoice_id = ? AND payment_allocations.is_deleted = 0`, args: [secondId] })
    expect(allocations.rows).toEqual([expect.objectContaining({ paymentMode: 'system_credit', cashPaise: 0, creditPaise: 10000 })])
    expect((await database().execute({ sql: 'SELECT status FROM invoices WHERE id = ?', args: [secondId] })).rows[0].status).toBe('paid')
  })

  it('applies area and payment-mode filters consistently across reports', async () => {
    const area = new ResponseMock()
    await areaHandler(request('POST', cookie, { serviceType: 'cable', displayName: 'Filtered Zone' }), area as unknown as VercelResponse)
    const areaId = Number((area.body as { id: number }).id)
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Filtered Customer', areaId, stbNumber: 'FILTER-BOX', planId: 1, installationDate: '2026-10-01', openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-07-05', amountReceivedPaise: 4000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'report-cash' }), new ResponseMock() as unknown as VercelResponse)
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-07-06', amountReceivedPaise: 1000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: 'report-upi' }), new ResponseMock() as unknown as VercelResponse)

    const report = new ResponseMock()
    await reportHandler(request('GET', cookie, undefined, { serviceType: 'cable', from: '2026-07-01', to: '2026-07-31', areaId: String(areaId), paymentMode: 'cash' }), report as unknown as VercelResponse)
    expect(report.body).toEqual(expect.objectContaining({ collectedPaise: 4000, activeSubscribers: 0, dataQualityCount: 0 }))
    expect((report.body as { payments: unknown[] }).payments).toHaveLength(1)
    expect((report.body as { trends: Array<{ month: string; collectedPaise: number }> }).trends).toContainEqual(expect.objectContaining({ month: '2026-07', collectedPaise: 4000 }))

    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-07-07', amountReceivedPaise: 4500, discountGivenPaise: 500, paymentMode: 'cash', requestKey: 'report-discount' }), new ResponseMock() as unknown as VercelResponse)
    const discountReport = new ResponseMock()
    await reportHandler(request('GET', cookie, undefined, { serviceType: 'cable', from: '2026-07-01', to: '2026-07-31', areaId: String(areaId), discountGiven: '1' }), discountReport as unknown as VercelResponse)
    expect(discountReport.body).toEqual(expect.objectContaining({ collectedPaise: 4500, discountGivenPaise: 500 }))
    expect((discountReport.body as { payments: Array<{ customerName: string; discountGivenPaise: number }> }).payments).toEqual([expect.objectContaining({ customerName: 'Filtered Customer', discountGivenPaise: 500 })])
  })

  it('persists settings, soft-deletes expenses, and reports all-business net revenue', async () => {
    const saved = new ResponseMock()
    await settingsHandler(request('PUT', cookie, { businessName: 'Sitaram Cable & Broadband', address: 'Bhavnagar', phoneNumbers: '9825039825', upiId: '9825039825@ybl', logoUrl: null }), saved as unknown as VercelResponse)
    expect(saved.statusCode).toBe(204)
    const settings = new ResponseMock()
    await settingsHandler(request('GET', cookie), settings as unknown as VercelResponse)
    expect(settings.body).toMatchObject({ businessName: 'Sitaram Cable & Broadband', upiId: '9825039825@ybl' })
    const expense = new ResponseMock()
    await expenseHandler(request('POST', cookie, { description: 'Test maintenance', amountPaise: 5000, expenseDate: '2026-07-02', category: 'Maintenance' }), expense as unknown as VercelResponse)
    expect(expense.statusCode).toBe(201)
    const report = new ResponseMock()
    await reportHandler(request('GET', cookie, undefined, { serviceType: 'all', from: '2026-07-01', to: '2026-07-31' }), report as unknown as VercelResponse)
    expect(report.body).toEqual(expect.objectContaining({ scope: 'all', expensePaise: 5000, netLabel: 'Net revenue' }))
    const removed = new ResponseMock()
    await expenseHandler(request('DELETE', cookie, undefined, { id: String((expense.body as { id: number }).id) }), removed as unknown as VercelResponse)
    expect(removed.statusCode).toBe(204)
    expect((await database().execute("SELECT is_deleted FROM expenses WHERE description = 'Test maintenance'")).rows[0].is_deleted).toBe(1)
  })

  it('makes invoice creation idempotent under concurrent retries', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Concurrent Customer', areaId: 1, stbNumber: 'CONCURRENT-BOX', planId: 1, installationDate: '2026-11-01', openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const expectedPeriodStart = '2026-11-01'
    const responses = [new ResponseMock(), new ResponseMock(), new ResponseMock()]
    await Promise.all(responses.map((response) => invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart }), response as unknown as VercelResponse)))
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200, 201])
    expect(new Set(responses.map((response) => (response.body as { invoiceId: number }).invoiceId)).size).toBe(1)
    expect(Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ? AND period_start = ? AND is_deleted = 0', args: [customerId, expectedPeriodStart] })).rows[0].count)).toBe(1)
    expect((await database().execute({ sql: 'SELECT next_billing_start_date FROM customers WHERE id = ?', args: [customerId] })).rows[0].next_billing_start_date).toBe('2026-12-01')
  })

  it('rejects invalid dates, zero-price plans, and case-insensitive STB duplicates', async () => {
    const invalidCustomer = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Bad Date', areaId: 1, planId: 1, installationDate: '2026-02-30', openingBalancePaise: 0, openingBalanceType: 'due' }), invalidCustomer as unknown as VercelResponse)
    expect(invalidCustomer.statusCode).toBe(400)
    const invalidPayment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: 1, paymentDate: 'not-a-date', amountReceivedPaise: 100, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'invalid-date' }), invalidPayment as unknown as VercelResponse)
    expect(invalidPayment.statusCode).toBe(400)
    const invalidBulk = new ResponseMock()
    await bulkInvoiceHandler(request('POST', cookie, { serviceType: 'cable', throughMonth: '2026-13' }), invalidBulk as unknown as VercelResponse)
    expect(invalidBulk.statusCode).toBe(400)
    const zeroPlan = new ResponseMock()
    await planHandler(request('POST', cookie, { serviceType: 'cable', name: 'Free Plan', pricePaise: 0, units: '' }), zeroPlan as unknown as VercelResponse)
    expect(zeroPlan.statusCode).toBe(400)
    const duplicateStb = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Duplicate Box', areaId: 1, stbNumber: ' box-22 ', planId: 1, installationDate: '2026-12-01', openingBalancePaise: 0, openingBalanceType: 'due' }), duplicateStb as unknown as VercelResponse)
    expect(duplicateStb.statusCode).toBe(409)
  })

  it('preserves historical payment identity and locks installation after billing starts', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Historical Name', areaId: 1, stbNumber: 'HISTORY-BOX', planId: 1, installationDate: '2027-01-01', openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-07-08', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'historical-payment' }), payment as unknown as VercelResponse)
    const paymentId = Number((await database().execute({ sql: 'SELECT id FROM payments WHERE payment_code = ?', args: [String((payment.body as { paymentCode: string }).paymentCode)] })).rows[0].id)
    const updated = new ResponseMock()
    await customerHandler(request('PUT', cookie, { id: customerId, serviceType: 'cable', name: 'Renamed Customer', areaId: 1, phone: '', stbNumber: 'RENAMED-BOX', planId: 1, installationDate: null, status: 'active' }), updated as unknown as VercelResponse)
    expect(updated.statusCode).toBe(409)
    expect((await database().execute({ sql: 'SELECT installation_date FROM customers WHERE id = ?', args: [customerId] })).rows[0].installation_date).toBe('2027-01-01')
    const detail = new ResponseMock()
    await paymentHandler(request('GET', cookie, undefined, { serviceType: 'cable', id: String(paymentId) }), detail as unknown as VercelResponse)
    expect(detail.body).toEqual(expect.objectContaining({ customerName: 'Historical Name', stbNumber: 'HISTORY-BOX', areaName: 'Main' }))
    const invoice = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: '2027-02-01' }), invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(409)
  })

  it('stores an administrator-selected invoice date separately from the service period', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Backdated Issue Date', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const invoice = new ResponseMock()
    const invoiceInput = await invoiceRequest(cookie, customerId)
    invoiceInput.body = { ...(invoiceInput.body as Record<string, unknown>), issuedDate: addBillingDays(todayInBusinessTimezone(), -1) }
    await invoiceHandler(invoiceInput, invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(201)
    const invoiceId = Number((await database().execute({ sql: 'SELECT id FROM invoices WHERE invoice_code = ?', args: [String((invoice.body as { invoiceCode: string }).invoiceCode)] })).rows[0].id)
    const detail = new ResponseMock()
    await invoiceHandler(request('GET', cookie, undefined, { serviceType: 'cable', id: String(invoiceId) }), detail as unknown as VercelResponse)
    expect(detail.body).toEqual(expect.objectContaining({ issuedDate: addBillingDays(todayInBusinessTimezone(), -1), periodStart: todayInBusinessTimezone() }))
  })

  it('keeps current service active when an early future renewal also exists', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Early Renewal', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    const listed = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: 'Early Renewal' }), listed as unknown as VercelResponse)
    expect((listed.body as { items: unknown[] }).items).toEqual([expect.objectContaining({ coverageStatus: 'active' })])
  })

  it('blocks new ledger documents for archived subscribers but permits inactive debt collection', async () => {
    const archived = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Archived Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), archived as unknown as VercelResponse)
    const archivedId = Number((archived.body as { id: number }).id)
    const first = new ResponseMock(); const second = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, archivedId), first as unknown as VercelResponse)
    await invoiceHandler(await invoiceRequest(cookie, archivedId), second as unknown as VercelResponse)
    const archivedResult = new ResponseMock()
    await customerHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(archivedId) }), archivedResult as unknown as VercelResponse)
    expect(archivedResult.statusCode).toBe(204)

    const archivedInvoice = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, archivedId), archivedInvoice as unknown as VercelResponse)
    expect(archivedInvoice.statusCode).toBe(409)
    expect(archivedInvoice.body).toEqual({ error: 'Archived subscribers cannot receive invoices. Restore the subscriber first.' })

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: archivedId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'archived-payment' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(409)
    expect(payment.body).toEqual({ error: 'Archived subscribers cannot receive payments. Restore the subscriber first.' })

    const merged = new ResponseMock()
    await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: [Number((first.body as { invoiceId: number }).invoiceId), Number((second.body as { invoiceId: number }).invoiceId)] }), merged as unknown as VercelResponse)
    expect(merged.statusCode).toBe(409)
    expect(merged.body).toEqual({ error: 'Archived subscribers cannot receive merged invoices. Restore the subscriber first.' })

    const restored = new ResponseMock()
    await customerHandler(request('PATCH', cookie, { serviceType: 'cable', id: archivedId }), restored as unknown as VercelResponse)
    expect(restored.statusCode).toBe(204)

    const inactiveInstallation = addBillingDays(todayInBusinessTimezone(), -30)
    const inactive = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Inactive Customer', areaId: 1, planId: 1, installationDate: inactiveInstallation, openingBalancePaise: 0, openingBalanceType: 'due' }), inactive as unknown as VercelResponse)
    const inactiveId = Number((inactive.body as { id: number }).id)
    await database().execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [inactiveInstallation, inactiveId] })
    await invoiceHandler(await invoiceRequest(cookie, inactiveId), new ResponseMock() as unknown as VercelResponse)
    const deactivated = new ResponseMock()
    await customerHandler(request('PUT', cookie, { id: inactiveId, serviceType: 'cable', name: 'Inactive Customer', areaId: 1, planId: 1, installationDate: inactiveInstallation, status: 'inactive', statusReason: 'Test inactive collection' }), deactivated as unknown as VercelResponse)
    expect(deactivated.statusCode).toBe(204)
    const collection = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: inactiveId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'inactive-payment' }), collection as unknown as VercelResponse)
    expect(collection.statusCode).toBe(201)
  })

  it('reports service-period revenue for every invoice overlapping the selected range', async () => {
    const reportQuery = { serviceType: 'cable', from: '2026-07-01', to: '2026-07-10', dateBasis: 'service' }
    const before = new ResponseMock()
    await reportHandler(request('GET', cookie, undefined, reportQuery), before as unknown as VercelResponse)
    expect(before.statusCode).toBe(200)
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Service Basis Boundary', areaId: 1, planId: 1, installationDate: '2026-06-20', openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const invoice = new ResponseMock()
    await invoiceHandler(request('POST', cookie, { serviceType: 'cable', customerId, monthsBilled: 1, expectedPeriodStart: todayInBusinessTimezone(), periodStart: '2026-06-20', billingMode: 'historical', historicalReason: 'Acceptance boundary test' }), invoice as unknown as VercelResponse)
    expect(invoice.statusCode).toBe(201)
    const report = new ResponseMock()
    await reportHandler(request('GET', cookie, undefined, reportQuery), report as unknown as VercelResponse)
    expect(report.statusCode).toBe(200)
    expect((report.body as { billedPaise: number }).billedPaise).toBe((before.body as { billedPaise: number }).billedPaise + 10000)
  })

  it('keeps historical invoice and payment area snapshots after an area rename', async () => {
    const area = new ResponseMock()
    await areaHandler(request('POST', cookie, { serviceType: 'cable', displayName: 'Snapshot Old Area' }), area as unknown as VercelResponse)
    const areaId = Number((area.body as { id: number }).id)
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Area Snapshot Customer', areaId, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const invoice = new ResponseMock(); await invoiceHandler(await invoiceRequest(cookie, customerId), invoice as unknown as VercelResponse)
    const payment = new ResponseMock(); await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: 'area-snapshot-payment' }), payment as unknown as VercelResponse)
    await areaHandler(request('PUT', cookie, { id: areaId, serviceType: 'cable', displayName: 'Snapshot New Area' }), new ResponseMock() as unknown as VercelResponse)
    const customerList = new ResponseMock(); await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: 'Area Snapshot Customer' }), customerList as unknown as VercelResponse)
    expect((customerList.body as { items: unknown[] }).items).toEqual([expect.objectContaining({ areaName: 'Snapshot New Area' })])
    const invoiceDetail = new ResponseMock(); await invoiceHandler(request('GET', cookie, undefined, { serviceType: 'cable', id: String((invoice.body as { invoiceId: number }).invoiceId) }), invoiceDetail as unknown as VercelResponse)
    expect(invoiceDetail.body).toEqual(expect.objectContaining({ areaName: 'Snapshot Old Area' }))
    const paymentId = Number((await database().execute({ sql: 'SELECT id FROM payments WHERE payment_code = ?', args: [(payment.body as { paymentCode: string }).paymentCode] })).rows[0].id)
    const paymentDetail = new ResponseMock(); await paymentHandler(request('GET', cookie, undefined, { serviceType: 'cable', id: String(paymentId) }), paymentDetail as unknown as VercelResponse)
    expect(paymentDetail.body).toEqual(expect.objectContaining({ areaName: 'Snapshot Old Area' }))
  })

  it('serializes distinct payments and simultaneous invoicing without over-allocation or lost money', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Concurrent Ledger Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 10000, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const invoice = new ResponseMock(); const earlyPayment = new ResponseMock()
    await Promise.all([
      invoiceHandler(await invoiceRequest(cookie, customerId), invoice as unknown as VercelResponse),
      paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 5000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'concurrent-ledger-early' }), earlyPayment as unknown as VercelResponse),
    ])
    expect(invoice.statusCode).toBe(201); expect(earlyPayment.statusCode).toBe(201)
    const responses = [new ResponseMock(), new ResponseMock()]
    await Promise.all(responses.map((response, index) => paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: index ? 'upi' : 'cash', requestKey: `concurrent-ledger-${index}` }), response as unknown as VercelResponse)))
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201])
    const totals = await database().execute({ sql: `SELECT (SELECT SUM(amount_paise) FROM invoice_charges WHERE invoice_id = ?) AS charges,
      (SELECT COALESCE(SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise), 0) FROM payment_allocations WHERE invoice_id = ? AND is_deleted = 0) AS allocated,
      (SELECT credit_balance_paise FROM customers WHERE id = ?) AS credit`, args: [(invoice.body as { invoiceId: number }).invoiceId, (invoice.body as { invoiceId: number }).invoiceId, customerId] })
    expect(Number(totals.rows[0].allocated)).toBeLessThanOrEqual(Number(totals.rows[0].charges))
    expect(Number(totals.rows[0].charges) - Number(totals.rows[0].allocated) - Number(totals.rows[0].credit)).toBe(-5000)
  })

  it('rolls back an invoice completely when its charge insert fails', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Rollback Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await database().execute("CREATE TRIGGER qa_abort_invoice_charge BEFORE INSERT ON invoice_charges WHEN NEW.description LIKE '%Prime service charge%' BEGIN SELECT RAISE(ABORT, 'forced QA failure'); END")
    try {
      const failed = new ResponseMock(); await invoiceHandler(await invoiceRequest(cookie, customerId), failed as unknown as VercelResponse)
      expect(failed.statusCode).toBe(500)
      expect(Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ?', args: [customerId] })).rows[0].count)).toBe(0)
      expect((await database().execute({ sql: 'SELECT next_billing_start_date FROM customers WHERE id = ?', args: [customerId] })).rows[0].next_billing_start_date).toBe(todayInBusinessTimezone())
    } finally { await database().execute('DROP TRIGGER qa_abort_invoice_charge') }
  })

  it('replays only an identical payment request and rejects request-key payload changes', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Idempotency Binding Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    const originalBody = { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 4000, discountGivenPaise: 0, paymentMode: 'cash', notes: 'Network retry', requestKey: 'bound-request-key' }
    const original = new ResponseMock(); await paymentHandler(request('POST', cookie, originalBody), original as unknown as VercelResponse)
    const replay = new ResponseMock(); await paymentHandler(request('POST', cookie, originalBody), replay as unknown as VercelResponse)
    expect(original.statusCode).toBe(201); expect(replay.statusCode).toBe(200); expect(replay.body).toEqual(expect.objectContaining({ replayed: true, paymentCode: (original.body as { paymentCode: string }).paymentCode }))
    const changed = new ResponseMock(); await paymentHandler(request('POST', cookie, { ...originalBody, amountReceivedPaise: 5000 }), changed as unknown as VercelResponse)
    expect(changed.statusCode).toBe(409)
    expect(Number((await database().execute({ sql: 'SELECT COUNT(*) AS count FROM payments WHERE customer_id = ? AND is_deleted = 0', args: [customerId] })).rows[0].count)).toBe(1)
  })

  it('serializes payment reversal against a simultaneous new collection', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Concurrent Reversal Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const invoice = new ResponseMock(); await invoiceHandler(await invoiceRequest(cookie, customerId), invoice as unknown as VercelResponse)
    const first = new ResponseMock(); await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 4000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'concurrent-reversal-first' }), first as unknown as VercelResponse)
    const firstId = Number((await database().execute({ sql: 'SELECT id FROM payments WHERE payment_code = ?', args: [(first.body as { paymentCode: string }).paymentCode] })).rows[0].id)
    const reversed = new ResponseMock(); const second = new ResponseMock()
    await Promise.all([
      paymentHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(firstId), reason: 'Concurrent correction test' }), reversed as unknown as VercelResponse),
      paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 6000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: 'concurrent-reversal-second' }), second as unknown as VercelResponse),
    ])
    expect(reversed.statusCode).toBe(204); expect(second.statusCode).toBe(201)
    const ledger = await database().execute({ sql: `SELECT
      (SELECT COUNT(*) FROM payments WHERE customer_id = ? AND is_deleted = 0) AS livePayments,
      (SELECT COALESCE(SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise), 0) FROM payment_allocations WHERE invoice_id = ? AND is_deleted = 0) AS allocated,
      (SELECT status FROM invoices WHERE id = ?) AS status`, args: [customerId, (invoice.body as { invoiceId: number }).invoiceId, (invoice.body as { invoiceId: number }).invoiceId] })
    expect(ledger.rows[0]).toMatchObject({ livePayments: 1, allocated: 6000, status: 'partial' })
  })

  it('rejects cross-customer, paid, non-consecutive, skipped, and repeated invoice merges', async () => {
    async function customerWithInvoices(name: string, count: number) {
      const created = new ResponseMock(); await customerHandler(request('POST', cookie, { serviceType: 'cable', name, areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
      const customerId = Number((created.body as { id: number }).id); const invoiceIds: number[] = []
      for (let index = 0; index < count; index += 1) { const invoice = new ResponseMock(); await invoiceHandler(await invoiceRequest(cookie, customerId), invoice as unknown as VercelResponse); invoiceIds.push(Number((invoice.body as { invoiceId: number }).invoiceId)) }
      return { customerId, invoiceIds }
    }
    const first = await customerWithInvoices('Merge Rules A', 2); const other = await customerWithInvoices('Merge Rules B', 1)
    const cross = new ResponseMock(); await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: [first.invoiceIds[0], other.invoiceIds[0]] }), cross as unknown as VercelResponse)
    expect(cross.statusCode).toBe(400)
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: first.customerId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 1000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'merge-rules-partial' }), new ResponseMock() as unknown as VercelResponse)
    const paid = new ResponseMock(); await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: first.invoiceIds }), paid as unknown as VercelResponse)
    expect(paid.statusCode).toBe(409)
    const clean = await customerWithInvoices('Merge Rules C', 3)
    const skipped = new ResponseMock(); await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: [clean.invoiceIds[0], clean.invoiceIds[2]] }), skipped as unknown as VercelResponse)
    expect(skipped.statusCode).toBe(409)
    const merged = new ResponseMock(); await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: clean.invoiceIds.slice(0, 2) }), merged as unknown as VercelResponse)
    expect(merged.statusCode).toBe(201)
    const repeated = new ResponseMock(); await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: clean.invoiceIds.slice(0, 2) }), repeated as unknown as VercelResponse)
    expect(repeated.statusCode).toBe(409)
    expect(repeated.body).toEqual({ error: 'One or more invoices have already been merged. Select the original unmerged invoices.' })
  })

  it('expires only the targeted session while a second administrator session remains usable', async () => {
    const first = new ResponseMock(); const second = new ResponseMock()
    await setSession(first as unknown as VercelResponse, 'first-session'); await setSession(second as unknown as VercelResponse, 'second-session')
    const firstCookie = String(first.headers.get('Set-Cookie')).split(';')[0]; const secondCookie = String(second.headers.get('Set-Cookie')).split(';')[0]
    await logoutHandler(request('POST', firstCookie), new ResponseMock() as unknown as VercelResponse)
    const rejected = new ResponseMock(); await customerHandler(request('GET', firstCookie, undefined, { serviceType: 'cable' }), rejected as unknown as VercelResponse)
    const accepted = new ResponseMock(); await customerHandler(request('GET', secondCookie, undefined, { serviceType: 'cable' }), accepted as unknown as VercelResponse)
    expect(rejected.statusCode).toBe(401); expect(accepted.statusCode).toBe(200)
    await database().execute("UPDATE admin_sessions SET expires_at = 0 WHERE username = 'second-session'")
    const expired = new ResponseMock(); await customerHandler(request('GET', secondCookie, undefined, { serviceType: 'cable' }), expired as unknown as VercelResponse)
    expect(expired.statusCode).toBe(401); expect(expired.body).toEqual({ error: 'Session expired. Please sign in again.' })
  })

  it('permanently deletes only archived customers without financial history', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Temporary Test Subscriber', areaId: 1, planId: null, installationDate: null, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    const archived = new ResponseMock(); await customerHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(customerId), reason: 'Test cleanup' }), archived as unknown as VercelResponse)
    expect(archived.statusCode).toBe(204)
    const removed = new ResponseMock(); await customerHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(customerId), permanent: '1', reason: 'Remove test record' }), removed as unknown as VercelResponse)
    expect(removed.statusCode).toBe(204)
    const archivedList = new ResponseMock(); await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', includeDeleted: '1' }), archivedList as unknown as VercelResponse)
    expect((archivedList.body as { items: Array<{ id: number }> }).items.some((item) => item.id === customerId)).toBe(false)
  })

  it('archives a selected subscriber batch atomically and records each audit event', async () => {
    const ids: number[] = []
    for (const name of ['Bulk Archive A', 'Bulk Archive B']) {
      const created = new ResponseMock()
      await customerHandler(request('POST', cookie, { serviceType: 'cable', name, areaId: 1, planId: null, installationDate: null, openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
      ids.push(Number((created.body as { id: number }).id))
    }

    const archived = new ResponseMock()
    await customerHandler(request('POST', cookie, { action: 'archive_many', serviceType: 'cable', ids, reason: 'Remove old duplicate records' }), archived as unknown as VercelResponse)
    expect(archived.statusCode).toBe(200)
    expect(archived.body).toEqual({ archived: 2 })
    const rows = await database().execute({ sql: `SELECT id, is_deleted AS isDeleted FROM customers WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, args: ids })
    expect(rows.rows).toEqual(ids.map((id) => expect.objectContaining({ id, isDeleted: 1 })))
    const audit = await database().execute({ sql: `SELECT entity_id AS entityId, reason FROM audit_events WHERE action = 'customer_archived' AND reason = ? AND entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY entity_id`, args: ['Remove old duplicate records', ...ids] })
    expect(audit.rows).toEqual(ids.map((id) => expect.objectContaining({ entityId: id, reason: 'Remove old duplicate records' })))

    const remaining = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Bulk Archive Atomic', areaId: 1, planId: null, installationDate: null, openingBalancePaise: 0, openingBalanceType: 'due' }), remaining as unknown as VercelResponse)
    const remainingId = Number((remaining.body as { id: number }).id)
    const rejected = new ResponseMock()
    await customerHandler(request('POST', cookie, { action: 'archive_many', serviceType: 'cable', ids: [remainingId, 999999] }), rejected as unknown as VercelResponse)
    expect(rejected.statusCode).toBe(409)
    expect((await database().execute({ sql: 'SELECT is_deleted AS isDeleted FROM customers WHERE id = ?', args: [remainingId] })).rows[0].isDeleted).toBe(0)
  })

  it('returns paginated customer items with a stable filtered total', async () => {
    const first = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', limit: '1', offset: '0' }), first as unknown as VercelResponse)
    const second = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', limit: '1', offset: '1' }), second as unknown as VercelResponse)
    const firstBody = first.body as { items: Array<{ id: number }>; total: number; limit: number; offset: number }
    const secondBody = second.body as { items: Array<{ id: number }>; total: number; limit: number; offset: number }
    expect(firstBody.limit).toBe(1)
    expect(firstBody.offset).toBe(0)
    expect(firstBody.items).toHaveLength(1)
    expect(secondBody.offset).toBe(1)
    expect(secondBody.total).toBe(firstBody.total)
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id)
  })

  it('authenticates, rotates the admin password, and rate-limits repeated failures', async () => {
    const login = new ResponseMock()
    await loginHandler(request('POST', '', { username: 'admin', password: 'OriginalPass123' }, {}, '10.0.0.1'), login as unknown as VercelResponse)
    expect(login.statusCode).toBe(200)
    const secondCookie = String(login.headers.get('Set-Cookie')).split(';')[0]
    const changed = new ResponseMock()
    await passwordHandler(request('PUT', cookie, { currentPassword: 'OriginalPass123', newPassword: 'ChangedPass456' }), changed as unknown as VercelResponse)
    expect(changed.statusCode).toBe(204)
    const revoked = new ResponseMock()
    await customerHandler(request('GET', secondCookie, undefined, { serviceType: 'cable' }), revoked as unknown as VercelResponse)
    expect(revoked.statusCode).toBe(401)
    const rotatedCookie = String(changed.headers.get('Set-Cookie')).split(';')[0]
    const logout = new ResponseMock()
    await logoutHandler(request('POST', rotatedCookie), logout as unknown as VercelResponse)
    expect(logout.statusCode).toBe(204)
    const loggedOut = new ResponseMock()
    await customerHandler(request('GET', rotatedCookie, undefined, { serviceType: 'cable' }), loggedOut as unknown as VercelResponse)
    expect(loggedOut.statusCode).toBe(401)
    const nextLogin = new ResponseMock()
    await loginHandler(request('POST', '', { username: 'admin', password: 'ChangedPass456' }, {}, '10.0.0.2'), nextLogin as unknown as VercelResponse)
    expect(nextLogin.statusCode).toBe(200)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = new ResponseMock()
      await loginHandler(request('POST', '', { username: 'admin', password: 'wrong-password' }, {}, '10.0.0.3'), failed as unknown as VercelResponse)
      expect(failed.statusCode).toBe(401)
    }
    const blocked = new ResponseMock()
    await loginHandler(request('POST', '', { username: 'admin', password: 'ChangedPass456' }, {}, '10.0.0.3'), blocked as unknown as VercelResponse)
    expect(blocked.statusCode).toBe(429)
  }, 20000)
})
