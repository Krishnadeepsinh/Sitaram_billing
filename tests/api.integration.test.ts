import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import invoiceHandler from '../api/invoices/index'
import bulkInvoiceHandler from '../api/invoices/bulk'
import mergeInvoiceHandler from '../api/invoices/merge'
import paymentHandler from '../api/payments/index'
import planHandler from '../api/plans/index'
import reportHandler from '../api/reports/index'
import customerHandler from '../api/customers/index'
import expenseHandler from '../api/expenses/index'
import backupHandler from '../api/backup'
import areaHandler from '../api/areas/index'
import settingsHandler from '../api/settings/index'
import loginHandler from '../api/auth/login'
import logoutHandler from '../api/auth/logout'
import passwordHandler from '../api/auth/password'
import { closeDatabase, database } from '../api/_lib/db'
import { setSession } from '../api/_lib/session'
import { readFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { todayInBusinessTimezone } from '../src/lib/date'

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
    expect(customers.body).toEqual([expect.objectContaining({ amountDuePaise: 10000, openInvoiceCount: 1, oldestDuePeriodStart: '2026-01-01', latestDuePeriodEnd: '2026-01-30' })])

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
    expect(invoiceSearch.body).toEqual(expect.objectContaining({ items: [expect.objectContaining({ customerId })], total: 1 }))

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId, paymentDate: '2026-05-02', amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: 'search-payment' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(201)
    const paymentSearch = new ResponseMock()
    await paymentHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: 'BOX-22' }), paymentSearch as unknown as VercelResponse)
    expect(paymentSearch.body).toEqual(expect.objectContaining({ items: [expect.objectContaining({ customerId })], total: 1 }))
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
    expect(report.body).toEqual(expect.objectContaining({ collectedPaise: 4000, activeSubscribers: 1, dataQualityCount: 0 }))
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

  it('keeps current service active when an early future renewal also exists', async () => {
    const created = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Early Renewal', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), created as unknown as VercelResponse)
    const customerId = Number((created.body as { id: number }).id)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    await invoiceHandler(await invoiceRequest(cookie, customerId), new ResponseMock() as unknown as VercelResponse)
    const listed = new ResponseMock()
    await customerHandler(request('GET', cookie, undefined, { serviceType: 'cable', query: 'Early Renewal' }), listed as unknown as VercelResponse)
    expect(listed.body).toEqual([expect.objectContaining({ coverageStatus: 'active' })])
  })

  it('blocks new ledger documents for archived subscribers but permits inactive debt collection', async () => {
    const archived = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Archived Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), archived as unknown as VercelResponse)
    const archivedId = Number((archived.body as { id: number }).id)
    const first = new ResponseMock(); const second = new ResponseMock()
    await invoiceHandler(await invoiceRequest(cookie, archivedId), first as unknown as VercelResponse)
    await invoiceHandler(await invoiceRequest(cookie, archivedId), second as unknown as VercelResponse)
    await customerHandler(request('DELETE', cookie, undefined, { serviceType: 'cable', id: String(archivedId), reason: 'Test archive rule' }), new ResponseMock() as unknown as VercelResponse)

    const payment = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: archivedId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'archived-payment' }), payment as unknown as VercelResponse)
    expect(payment.statusCode).toBe(409)
    expect(payment.body).toEqual({ error: 'Archived subscribers cannot receive payments. Restore the subscriber first.' })

    const merged = new ResponseMock()
    await mergeInvoiceHandler(request('POST', cookie, { serviceType: 'cable', invoiceIds: [Number((first.body as { invoiceId: number }).invoiceId), Number((second.body as { invoiceId: number }).invoiceId)] }), merged as unknown as VercelResponse)
    expect(merged.statusCode).toBe(409)
    expect(merged.body).toEqual({ error: 'Archived subscribers cannot receive merged invoices. Restore the subscriber first.' })

    const inactive = new ResponseMock()
    await customerHandler(request('POST', cookie, { serviceType: 'cable', name: 'Inactive Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), openingBalancePaise: 0, openingBalanceType: 'due' }), inactive as unknown as VercelResponse)
    const inactiveId = Number((inactive.body as { id: number }).id)
    await invoiceHandler(await invoiceRequest(cookie, inactiveId), new ResponseMock() as unknown as VercelResponse)
    await customerHandler(request('PUT', cookie, { id: inactiveId, serviceType: 'cable', name: 'Inactive Customer', areaId: 1, planId: 1, installationDate: todayInBusinessTimezone(), status: 'inactive', statusReason: 'Test inactive collection' }), new ResponseMock() as unknown as VercelResponse)
    const collection = new ResponseMock()
    await paymentHandler(request('POST', cookie, { serviceType: 'cable', customerId: inactiveId, paymentDate: todayInBusinessTimezone(), amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: 'inactive-payment' }), collection as unknown as VercelResponse)
    expect(collection.statusCode).toBe(201)
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
  })
})
