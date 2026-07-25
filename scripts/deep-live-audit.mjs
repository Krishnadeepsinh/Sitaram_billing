import assert from 'node:assert/strict'
import { loadEnvFile } from 'node:process'
import { createClient } from '@libsql/client'

loadEnvFile('.env.local')

if (process.env.ALLOW_DESTRUCTIVE_LIVE_TEST !== 'true') throw new Error('Set ALLOW_DESTRUCTIVE_LIVE_TEST=true to run the live audit.')
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:5173'
const username = process.env.QA_ADMIN_USERNAME || 'adminshakti'
const password = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD
if (!password) throw new Error('Set QA_ADMIN_PASSWORD before running this destructive live audit.')
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error('Turso environment is missing.')

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const run = `QA-${Date.now()}`
const created = { areas: [], plans: [], customers: [], expenses: [] }
let cookie = ''
let checks = 0
const findings = []

function pass(condition, message) {
  assert.ok(condition, message)
  checks++
  console.log(`PASS ${String(checks).padStart(2, '0')}  ${message}`)
}

function observe(condition, message, evidence) {
  if (condition) pass(true, message)
  else {
    findings.push({ message, evidence })
    console.log(`FINDING  ${message}: ${evidence}`)
  }
}

function businessToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts().map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

async function api(path, { method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';', 1)[0]
  const text = await response.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : undefined
  if (!expected.includes(response.status)) throw new Error(`${method} ${path}: expected ${expected.join('/')}, got ${response.status}: ${text}`)
  return { status: response.status, data }
}

async function cleanup(settings, sequences) {
  const transaction = db
    if (created.customers.length) {
      const customerMarks = created.customers.map(() => '?').join(',')
      const invoiceRows = await transaction.execute({ sql: `SELECT id FROM invoices WHERE customer_id IN (${customerMarks})`, args: created.customers })
      const invoiceIds = invoiceRows.rows.map((row) => Number(row.id))
      const paymentRows = await transaction.execute({ sql: `SELECT id FROM payments WHERE customer_id IN (${customerMarks})`, args: created.customers })
      const paymentIds = paymentRows.rows.map((row) => Number(row.id))
      if (paymentIds.length) {
        await transaction.execute({ sql: `DELETE FROM payment_charge_allocations WHERE payment_allocation_id IN (SELECT id FROM payment_allocations WHERE payment_id IN (${paymentIds.map(() => '?').join(',')}))`, args: paymentIds })
        await transaction.execute({ sql: `DELETE FROM payment_allocations WHERE payment_id IN (${paymentIds.map(() => '?').join(',')})`, args: paymentIds })
      }
      if (invoiceIds.length) {
        const invoiceMarks = invoiceIds.map(() => '?').join(',')
        await transaction.execute({ sql: `DELETE FROM invoice_merge_items WHERE merged_invoice_id IN (${invoiceMarks}) OR source_invoice_id IN (${invoiceMarks})`, args: [...invoiceIds, ...invoiceIds] })
        await transaction.execute({ sql: `DELETE FROM invoice_charges WHERE invoice_id IN (${invoiceMarks})`, args: invoiceIds })
      }
      if (paymentIds.length) await transaction.execute({ sql: `DELETE FROM payments WHERE id IN (${paymentIds.map(() => '?').join(',')})`, args: paymentIds })
      if (invoiceIds.length) await transaction.execute({ sql: `DELETE FROM invoices WHERE id IN (${invoiceIds.map(() => '?').join(',')})`, args: invoiceIds })
      await transaction.execute({ sql: `DELETE FROM customer_status_history WHERE customer_id IN (${customerMarks})`, args: created.customers })
      await transaction.execute({ sql: `DELETE FROM customer_plan_history WHERE customer_id IN (${customerMarks})`, args: created.customers })
      await transaction.execute({ sql: `DELETE FROM customer_plan_gaps WHERE customer_id IN (${customerMarks})`, args: created.customers })
      await transaction.execute({ sql: `DELETE FROM customers WHERE id IN (${customerMarks})`, args: created.customers })
    }
    for (const table of ['expense', 'customer', 'invoice', 'payment', 'plan']) {
      await transaction.execute({ sql: 'DELETE FROM audit_events WHERE entity_type = ? AND created_at >= ?', args: [table, startedAt] })
    }
    if (created.expenses.length) await transaction.execute({ sql: `DELETE FROM expenses WHERE id IN (${created.expenses.map(() => '?').join(',')})`, args: created.expenses })
    if (created.plans.length) await transaction.execute({ sql: `DELETE FROM plans WHERE id IN (${created.plans.map(() => '?').join(',')})`, args: created.plans })
    if (created.areas.length) await transaction.execute({ sql: `DELETE FROM areas WHERE id IN (${created.areas.map(() => '?').join(',')})`, args: created.areas })
    await transaction.execute('DELETE FROM id_sequences')
    for (const row of sequences) await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, ?)', args: [row.entity_type, row.service_type, row.last_number] })
    if (settings) {
      await transaction.execute({ sql: `INSERT INTO business_settings (id, business_name, address, phone_numbers, upi_id, logo_url, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET business_name=excluded.business_name,address=excluded.address,phone_numbers=excluded.phone_numbers,upi_id=excluded.upi_id,logo_url=excluded.logo_url,updated_at=excluded.updated_at`,
        args: [settings.business_name, settings.address, settings.phone_numbers, settings.upi_id, settings.logo_url, settings.updated_at] })
    } else await transaction.execute('DELETE FROM business_settings WHERE id = 1')
}

const startedAt = new Date().toISOString()
const previousSettings = (await db.execute('SELECT * FROM business_settings WHERE id = 1')).rows[0] || null
const previousSequences = [...(await db.execute('SELECT * FROM id_sequences')).rows]
const today = businessToday()

try {
  const health = await api('/api/health')
  pass(health.data.status === 'ok' && health.data.storage === 'cloud', 'health endpoint uses cloud storage')

  const login = await api('/api/auth/login', { method: 'POST', body: { username, password } })
  pass(login.data.username === username && Boolean(cookie), 'administrator login and session cookie')
  pass((await api('/api/auth/me')).data.username === username, 'authenticated session lookup')

  await api('/api/settings', { method: 'PUT', expected: [204], body: { businessName: `${run} Billing`, address: 'QA address', phoneNumbers: '9999999999', upiId: 'qa@upi', logoUrl: null } })
  pass((await api('/api/settings')).data.businessName === `${run} Billing`, 'business settings save and reload')

  const cableArea = await api('/api/areas', { method: 'POST', expected: [201], body: { serviceType: 'cable', displayName: `${run} Cable Area` } })
  created.areas.push(cableArea.data.id)
  const broadbandArea = await api('/api/areas', { method: 'POST', expected: [201], body: { serviceType: 'broadband', displayName: `${run} Broadband Area` } })
  created.areas.push(broadbandArea.data.id)
  const reusedArea = await api('/api/areas', { method: 'POST', body: { serviceType: 'cable', displayName: `  ${run}   Cable Area ` } })
  pass(reusedArea.data.id === cableArea.data.id && reusedArea.data.reused === true, 'normalized duplicate area is safely reused')

  const cablePlan = await api('/api/plans', { method: 'POST', expected: [201], body: { serviceType: 'cable', name: `${run} Cable 200`, pricePaise: 20000, units: '30 days' } })
  created.plans.push(cablePlan.data.id)
  const broadbandPlan = await api('/api/plans', { method: 'POST', expected: [201], body: { serviceType: 'broadband', name: `${run} Fiber 500`, pricePaise: 50000, units: '100 Mbps' } })
  created.plans.push(broadbandPlan.data.id)
  pass((await api('/api/plans', { method: 'POST', expected: [409], body: { serviceType: 'cable', name: `${run} CABLE 200`, pricePaise: 20000, units: 'duplicate' } })).status === 409, 'duplicate plan name is blocked case-insensitively')

  async function customer(suffix, overrides = {}) {
    const result = await api('/api/customers', { method: 'POST', expected: [201], body: {
      serviceType: 'cable', name: `${run} ${suffix}`, areaId: cableArea.data.id, phone: `90000${String(created.customers.length).padStart(5, '0')}`,
      stbNumber: `${run}-STB-${suffix}`, planId: cablePlan.data.id, installationDate: today, openingBalancePaise: 0, openingBalanceType: 'due', ...overrides,
    } })
    created.customers.push(result.data.id)
    return result.data
  }

  const discountCustomer = await customer('DISCOUNT')
  const concurrencyCustomer = await customer('CONCURRENT', { openingBalancePaise: 5000, openingBalanceType: 'advance' })
  const historicalCustomer = await customer('HISTORICAL', { installationDate: addDays(today, -120) })
  const noPlanCustomer = await customer('NO-PLAN', { planId: null })
  const futureCustomer = await customer('FUTURE', { installationDate: addDays(today, 20) })
  const broadbandCustomerResult = await api('/api/customers', { method: 'POST', expected: [201], body: { serviceType: 'broadband', name: `${run} BROADBAND`, areaId: broadbandArea.data.id, phone: '9888888888', stbNumber: `${run}-BB`, planId: broadbandPlan.data.id, installationDate: today, openingBalancePaise: 0, openingBalanceType: 'due' } })
  created.customers.push(broadbandCustomerResult.data.id)
  pass(created.customers.length === 6, 'multiple cable and broadband subscribers created')

  pass((await api('/api/customers', { method: 'POST', expected: [409], body: { serviceType: 'cable', name: `${run} DUP-STB`, areaId: cableArea.data.id, stbNumber: `${run}-STB-DISCOUNT`, planId: cablePlan.data.id, installationDate: today, openingBalancePaise: 0, openingBalanceType: 'due' } })).status === 409, 'duplicate active STB number is blocked')
  pass((await api('/api/customers', { method: 'POST', expected: [400], body: { serviceType: 'cable', name: `${run} WRONG-AREA`, areaId: broadbandArea.data.id, planId: cablePlan.data.id, installationDate: today, openingBalancePaise: 0, openingBalanceType: 'due' } })).status === 400, 'cross-service area assignment is blocked')
  pass((await api('/api/areas?serviceType=cable&id=' + cableArea.data.id, { method: 'DELETE', expected: [409] })).status === 409, 'referenced area deletion is blocked')

  const firstInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: discountCustomer.id, monthsBilled: 2, expectedPeriodStart: today } })
  pass(firstInvoice.data.periodStart === today && firstInvoice.data.periodEnd === addDays(today, 59), 'two-cycle invoice covers exactly 60 calendar days')
  const invoiceList = await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(discountCustomer.customerCode)}`)
  const invoice = invoiceList.data.items.find((item) => item.invoiceCode === firstInvoice.data.invoiceCode)
  pass(invoice.totalPayablePaise === 40000 && invoice.balancePaise === 40000 && invoice.status === 'unpaid', 'two-cycle invoice totals ₹400 and starts unpaid')

  const exactReplay = await api('/api/invoices', { method: 'POST', body: { serviceType: 'cable', customerId: discountCustomer.id, monthsBilled: 2, expectedPeriodStart: today } })
  pass(exactReplay.data.invoiceCode === firstInvoice.data.invoiceCode && exactReplay.data.replayed === true, 'exact duplicate invoice request is idempotently replayed')
  pass((await api('/api/invoices', { method: 'POST', expected: [409], body: { serviceType: 'cable', customerId: discountCustomer.id, monthsBilled: 1, expectedPeriodStart: today, periodStart: today } })).status === 409, 'different overlapping renewal is blocked')

  const secondInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: discountCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 60) } })
  pass(secondInvoice.data.periodStart === addDays(today, 60) && secondInvoice.data.periodEnd === addDays(today, 89), 'future non-overlapping renewal starts the next day')

  const discountPayment = await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: discountCustomer.id, paymentDate: today, amountReceivedPaise: 35000, discountGivenPaise: 5000, paymentMode: 'cash', notes: 'QA discount settlement', requestKey: `${run}-discount-payment` } })
  const afterDiscount = await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(firstInvoice.data.invoiceCode)}`)
  pass(afterDiscount.data.items[0].status === 'paid' && afterDiscount.data.items[0].balancePaise === 0, '₹350 cash plus ₹50 discount fully settles the ₹400 invoice')
  const discountCustomerState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(discountCustomer.customerCode)}`)).data[0]
  pass(discountCustomerState.creditBalancePaise === 0, 'discount creates no customer advance credit')
  const paymentReplay = await api('/api/payments', { method: 'POST', body: { serviceType: 'cable', customerId: discountCustomer.id, paymentDate: today, amountReceivedPaise: 35000, discountGivenPaise: 5000, paymentMode: 'cash', notes: 'QA discount settlement', requestKey: `${run}-discount-payment` } })
  pass(paymentReplay.data.paymentCode === discountPayment.data.paymentCode && paymentReplay.data.replayed === true, 'duplicate payment request key is idempotent')
  pass((await api('/api/payments', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: discountCustomer.id, paymentDate: today, amountReceivedPaise: 0, discountGivenPaise: 30001, paymentMode: 'cash', requestKey: `${run}-excess-discount` } })).status === 400, 'discount greater than remaining due is blocked')
  pass((await api('/api/payments', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: discountCustomer.id, paymentDate: addDays(today, 1), amountReceivedPaise: 100, discountGivenPaise: 0, paymentMode: 'upi', requestKey: `${run}-future-payment` } })).status === 400, 'future-dated payment is blocked')

  const paymentList = await api(`/api/payments?serviceType=cable&query=${encodeURIComponent(discountPayment.data.paymentCode)}`)
  const recordedPayment = paymentList.data.items[0]
  const paymentPreview = await api(`/api/payments?serviceType=cable&deletePreview=${recordedPayment.id}`)
  pass(paymentPreview.data.invoices.some((item) => item.invoiceCode === firstInvoice.data.invoiceCode), 'payment deletion preview identifies affected invoice')
  await api(`/api/payments?serviceType=cable&id=${recordedPayment.id}&reason=QA%20payment%20correction`, { method: 'DELETE', expected: [204] })
  const afterReversal = await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(firstInvoice.data.invoiceCode)}`)
  pass(afterReversal.data.items[0].status === 'unpaid' && afterReversal.data.items[0].balancePaise === 40000, 'payment deletion reopens the paid invoice')

  const replacementPayment = await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: discountCustomer.id, paymentDate: today, amountReceivedPaise: 35000, discountGivenPaise: 5000, paymentMode: 'upi', requestKey: `${run}-replacement-payment` } })
  const report = await api(`/api/reports?serviceType=cable&from=${today}&to=${today}&discountGiven=true`)
  pass(report.data.discountGivenPaise >= 5000 && report.data.payments.some((item) => item.paymentCode === replacementPayment.data.paymentCode), 'discount report filter includes the discounted customer')

  const invoicePreview = await api(`/api/invoices?serviceType=cable&deletePreview=${invoice.id}`)
  pass(invoicePreview.data.payments.some((item) => item.paymentCode === replacementPayment.data.paymentCode), 'invoice deletion preview identifies linked payment')
  pass((await api(`/api/invoices?serviceType=cable&id=${invoice.id}&reason=QA%20historical%20correction`, { method: 'DELETE', expected: [204] })).status === 204, 'historical invoice can be deleted with an audit reason and shared payments remain safe')
  const latestInvoiceRow = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(secondInvoice.data.invoiceCode)}`)).data.items[0]
  await api(`/api/invoices?serviceType=cable&id=${latestInvoiceRow.id}&reason=QA%20remove%20latest`, { method: 'DELETE', expected: [204] })
  pass((await api(`/api/payments?serviceType=cable&query=${encodeURIComponent(replacementPayment.data.paymentCode)}`)).data.total === 0, 'deleting paid invoice also deletes its linked payment')

  const concurrentBody = { serviceType: 'cable', customerId: concurrencyCustomer.id, monthsBilled: 1, expectedPeriodStart: today }
  const concurrent = await Promise.all([api('/api/invoices', { method: 'POST', expected: [200, 201], body: concurrentBody }), api('/api/invoices', { method: 'POST', expected: [200, 201], body: concurrentBody })])
  pass(concurrent[0].data.invoiceCode === concurrent[1].data.invoiceCode && concurrent.filter((item) => item.status === 201).length === 1, 'simultaneous invoice clicks create exactly one invoice')
  const concurrencyInvoice = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(concurrent[0].data.invoiceCode)}`)).data.items[0]
  pass(concurrencyInvoice.balancePaise === 15000 && concurrencyInvoice.status === 'partial', '₹50 opening advance is automatically applied to ₹200 invoice')

  pass((await api('/api/invoices', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: noPlanCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })).status === 400, 'customer without a plan cannot be invoiced')
  pass((await api('/api/invoices', { method: 'POST', expected: [409], body: { serviceType: 'cable', customerId: futureCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })).status === 409, 'future installation cannot be billed from today')
  const futureStart = addDays(today, 20)
  const futureInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: futureCustomer.id, monthsBilled: 1, expectedPeriodStart: futureStart } })
  pass(futureInvoice.data.periodStart === futureStart, 'future customer bills from installation date')
  const futureState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(futureCustomer.customerCode)}`)).data[0]
  pass(futureState.previousDuePaise === 0 && futureState.currentPlanDuePaise === 0 && futureState.futurePlanDuePaise === 20000 && futureState.amountDuePaise === 20000, 'future renewal is isolated in the next/future due bucket')

  const historicalStart = addDays(today, -120)
  const historicalInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: historicalCustomer.id, monthsBilled: 1, expectedPeriodStart: historicalStart, periodStart: historicalStart, billingMode: 'historical', historicalReason: 'QA missed historical cycle' } })
  pass(historicalInvoice.data.periodEnd === addDays(historicalStart, 29), 'historical invoice uses an exact 30-day period')
  pass((await api('/api/invoices', { method: 'POST', expected: [409], body: { serviceType: 'cable', customerId: historicalCustomer.id, monthsBilled: 2, expectedPeriodStart: historicalStart, periodStart: historicalStart, billingMode: 'historical', historicalReason: 'QA overlapping historical cycle' } })).status === 409, 'overlapping historical invoice is blocked')
  pass((await api('/api/invoices', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: historicalCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 1), periodStart: addDays(today, 1), billingMode: 'historical', historicalReason: 'QA future historical cycle' } })).status === 400, 'historical invoice cannot extend into the future')
  const gapStart = addDays(today, -60)
  await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: historicalCustomer.id, monthsBilled: 1, expectedPeriodStart: gapStart, periodStart: gapStart, billingMode: 'historical', historicalReason: 'QA intentional unbilled gap test' } })
  const historicalState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(historicalCustomer.customerCode)}`)).data[0]
  pass(historicalState.hasHistoricalGap === 1, 'historical gap is detected and surfaced')
  pass(historicalState.previousDuePaise === historicalState.amountDuePaise && historicalState.currentPlanDuePaise === 0 && historicalState.futurePlanDuePaise === 0, 'expired unpaid historical charges are isolated in previous due')

  const ledgerCustomer = await customer('LEDGER', { openingBalancePaise: 10000, openingBalanceType: 'due' })
  const ledgerOpeningState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(ledgerCustomer.customerCode)}`)).data[0]
  pass(ledgerOpeningState.previousDuePaise === 10000 && ledgerOpeningState.currentPlanDuePaise === 0 && ledgerOpeningState.futurePlanDuePaise === 0 && ledgerOpeningState.unbilledOpeningDuePaise === 10000, 'uninvoiced opening balance is immediately visible as previous due')
  const ledgerPreview = await api(`/api/invoices?serviceType=cable&previewCustomerId=${ledgerCustomer.id}&monthsBilled=1&periodStart=${today}&billingMode=normal`)
  pass(ledgerPreview.data.previousDuePaise === 10000 && ledgerPreview.data.currentChargePaise === 20000 && ledgerPreview.data.totalPayablePaise === 30000, 'invoice preview separates previous due, current charge, and total payable')
  const ledgerFirst = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: ledgerCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  const ledgerFirstRow = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(ledgerFirst.data.invoiceCode)}`)).data.items[0]
  pass(ledgerFirstRow.balancePaise === 30000 && ledgerFirstRow.totalPayablePaise === 30000, 'opening due is charged on the first invoice exactly once')
  const ledgerSecond = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: ledgerCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 30) } })
  const ledgerSecondRow = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(ledgerSecond.data.invoiceCode)}`)).data.items[0]
  pass(ledgerSecondRow.balancePaise === 20000 && ledgerSecondRow.totalPayablePaise === 50000, 'later invoice shows prior due without duplicating it into ledger balance')
  const ledgerBucketState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(ledgerCustomer.customerCode)}`)).data[0]
  pass(ledgerBucketState.previousDuePaise === 10000 && ledgerBucketState.currentPlanDuePaise === 20000 && ledgerBucketState.futurePlanDuePaise === 20000 && ledgerBucketState.amountDuePaise === 50000, 'opening, current, and future dues add exactly to total outstanding')
  const ledgerPayment = await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: ledgerCustomer.id, paymentDate: today, amountReceivedPaise: 35000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: `${run}-oldest-first` } })
  const ledgerPaymentRow = (await api(`/api/payments?serviceType=cable&query=${encodeURIComponent(ledgerPayment.data.paymentCode)}`)).data.items[0]
  const ledgerPaymentDetail = await api(`/api/payments?serviceType=cable&id=${ledgerPaymentRow.id}`)
  const ledgerAllocationTotals = Object.groupBy(ledgerPaymentDetail.data.allocations, (item) => item.invoiceCode)
  pass(Object.values(ledgerAllocationTotals).length === 2 && ledgerAllocationTotals[ledgerFirst.data.invoiceCode].reduce((sum, item) => sum + item.cashPaise, 0) === 30000 && ledgerAllocationTotals[ledgerSecond.data.invoiceCode].reduce((sum, item) => sum + item.cashPaise, 0) === 5000, 'one payment allocates oldest invoice first across multiple invoices')
  const ledgerAfter = await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(ledgerCustomer.customerCode)}`)
  pass(ledgerAfter.data.items.find((item) => item.invoiceCode === ledgerFirst.data.invoiceCode).status === 'paid' && ledgerAfter.data.items.find((item) => item.invoiceCode === ledgerSecond.data.invoiceCode).balancePaise === 15000, 'oldest invoice is paid and newer invoice remains partial')
  await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: ledgerCustomer.id, paymentDate: today, amountReceivedPaise: 20000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: `${run}-overpayment-credit` } })
  let ledgerState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(ledgerCustomer.customerCode)}`)).data[0]
  pass(ledgerState.creditBalancePaise === 5000 && ledgerState.amountDuePaise === 0, 'cash overpayment becomes advance credit only after all dues are cleared')
  const ledgerThird = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: ledgerCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 60) } })
  const ledgerThirdRow = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(ledgerThird.data.invoiceCode)}`)).data.items[0]
  ledgerState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(ledgerCustomer.customerCode)}`)).data[0]
  pass(ledgerThirdRow.status === 'partial' && ledgerThirdRow.balancePaise === 15000 && ledgerState.creditBalancePaise === 0, 'advance credit automatically applies to the next invoice')

  const prepaidOpeningCustomer = await customer('PRE-INVOICE-PAYMENT', { openingBalancePaise: 100000, openingBalanceType: 'due' })
  await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: prepaidOpeningCustomer.id, paymentDate: today, amountReceivedPaise: 30000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: `${run}-preinvoice-opening-payment` } })
  let prepaidOpeningState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(prepaidOpeningCustomer.customerCode)}`)).data[0]
  pass(prepaidOpeningState.amountDuePaise === 100000 && prepaidOpeningState.creditBalancePaise === 30000 && prepaidOpeningState.unbilledOpeningDuePaise === 100000, 'cash collected before first invoice is held as explicit advance against the uninvoiced opening due')
  pass((await api('/api/payments', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: prepaidOpeningCustomer.id, paymentDate: today, amountReceivedPaise: 0, discountGivenPaise: 1000, paymentMode: 'cash', requestKey: `${run}-preinvoice-opening-discount` } })).status === 400, 'discount against uninvoiced opening due is blocked with no credit creation')
  await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: prepaidOpeningCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  prepaidOpeningState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(prepaidOpeningCustomer.customerCode)}`)).data[0]
  pass(prepaidOpeningState.previousDuePaise === 70000 && prepaidOpeningState.currentPlanDuePaise === 20000 && prepaidOpeningState.futurePlanDuePaise === 0 && prepaidOpeningState.amountDuePaise === 90000 && prepaidOpeningState.creditBalancePaise === 0, 'first invoice consumes prepayment and exposes ₹700 previous plus ₹200 current due')

  const mergeCustomer = await customer('MERGE')
  const mergeOne = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: mergeCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  const mergeTwo = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: mergeCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 30) } })
  const mergeRows = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(mergeCustomer.customerCode)}`)).data.items
  const mergeResult = await api('/api/invoices/merge', { method: 'POST', expected: [201, 500], body: { serviceType: 'cable', invoiceIds: [mergeRows.find((item) => item.invoiceCode === mergeOne.data.invoiceCode).id, mergeRows.find((item) => item.invoiceCode === mergeTwo.data.invoiceCode).id] } })
  observe(mergeResult.status === 201, 'two consecutive unpaid invoices can be merged', `HTTP ${mergeResult.status}: ${mergeResult.data?.error || 'unknown error'}`)
  if (mergeResult.status === 201) {
    const mergedDetail = await api(`/api/invoices?serviceType=cable&id=${mergeResult.data.invoiceId}`)
    pass(mergedDetail.data.mergeItems.length === 2 && mergedDetail.data.currentPeriodAmountPaise === 40000, 'merged invoice preserves both source periods and exact total')
    const mergedPayment = await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: mergeCustomer.id, paymentDate: today, amountReceivedPaise: 39000, discountGivenPaise: 1000, paymentMode: 'cash', requestKey: `${run}-merged-payment` } })
    const mergedPaymentRow = (await api(`/api/payments?serviceType=cable&query=${encodeURIComponent(mergedPayment.data.paymentCode)}`)).data.items[0]
    pass((await api(`/api/invoices?serviceType=cable&id=${mergeResult.data.invoiceId}`)).data.status === 'paid', 'merged invoice accepts cash plus discount settlement')
    await api(`/api/payments?serviceType=cable&id=${mergedPaymentRow.id}&reason=QA%20merged%20payment%20reversal`, { method: 'DELETE', expected: [204] })
    pass((await api(`/api/invoices?serviceType=cable&id=${mergeResult.data.invoiceId}`)).data.status === 'unpaid', 'reversing merged payment reopens combined invoice')
    await api(`/api/invoices?serviceType=cable&id=${mergeResult.data.invoiceId}&reason=QA%20unmerge%20invoices`, { method: 'DELETE', expected: [204] })
    const restoredSources = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(mergeCustomer.customerCode)}`)).data.items
    pass(restoredSources.length === 2 && restoredSources.every((item) => item.isMerged === 0), 'deleting combined invoice restores both original invoices')
  }

  const cascadeCustomer = await customer('CASCADE')
  const cascadeOne = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: cascadeCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  const cascadeTwo = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: cascadeCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 30) } })
  const cascadePayment = await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: cascadeCustomer.id, paymentDate: today, amountReceivedPaise: 30000, discountGivenPaise: 0, paymentMode: 'upi', requestKey: `${run}-cascade-payment` } })
  const cascadeRows = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(cascadeCustomer.customerCode)}`)).data.items
  const cascadeLatest = cascadeRows.find((item) => item.invoiceCode === cascadeTwo.data.invoiceCode)
  const cascadePreview = await api(`/api/invoices?serviceType=cable&deletePreview=${cascadeLatest.id}`)
  pass(cascadePreview.data.affectedInvoices.some((item) => item.invoiceCode === cascadeOne.data.invoiceCode), 'invoice deletion preview warns when one payment also affects another invoice')
  await api(`/api/invoices?serviceType=cable&id=${cascadeLatest.id}&reason=QA%20cascade%20deletion`, { method: 'DELETE', expected: [204] })
  const cascadeFirstAfter = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(cascadeOne.data.invoiceCode)}`)).data.items[0]
  pass(cascadeFirstAfter.status === 'paid' && (await api(`/api/payments?serviceType=cable&query=${encodeURIComponent(cascadePayment.data.paymentCode)}`)).data.total === 1, 'deleting one invoice preserves a shared payment and reallocates it to the remaining invoice')

  const archivedCustomer = await customer('ARCHIVED')
  const archivedFirst = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: archivedCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  const archivedSecond = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: archivedCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 30) } })
  await api(`/api/customers?serviceType=cable&id=${archivedCustomer.id}&reason=QA%20archive%20behavior`, { method: 'DELETE', expected: [204] })
  const archivedPayment = await api('/api/payments', { method: 'POST', expected: [201, 404, 409], body: { serviceType: 'cable', customerId: archivedCustomer.id, paymentDate: today, amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: `${run}-archived-payment` } })
  observe(archivedPayment.status !== 201, 'archived subscriber rejects new payment entry', `HTTP ${archivedPayment.status} created ${archivedPayment.data?.paymentCode || 'a payment'}`)
  const archivedRows = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(archivedCustomer.customerCode)}`)).data.items
  pass((await api('/api/invoices/merge', { method: 'POST', expected: [409], body: { serviceType: 'cable', invoiceIds: [archivedRows.find((item) => item.invoiceCode === archivedFirst.data.invoiceCode).id, archivedRows.find((item) => item.invoiceCode === archivedSecond.data.invoiceCode).id] } })).status === 409, 'archived subscriber rejects merged invoice entry')
  pass((await api('/api/invoices', { method: 'POST', expected: [409], body: { serviceType: 'cable', customerId: archivedCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 60) } })).status === 409, 'archived subscriber rejects new invoice entry')

  const inactiveCustomer = await customer('INACTIVE')
  await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: inactiveCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  await api('/api/customers', { method: 'PUT', expected: [204], body: { serviceType: 'cable', id: inactiveCustomer.id, name: `${run} INACTIVE`, areaId: cableArea.data.id, phone: '9111111111', stbNumber: `${run}-STB-INACTIVE`, planId: cablePlan.data.id, installationDate: today, status: 'inactive', statusReason: 'QA service suspension' } })
  pass((await api('/api/invoices', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: inactiveCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 30) } })).status === 400, 'inactive subscriber cannot receive renewal invoice')
  const inactivePayment = await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: inactiveCustomer.id, paymentDate: today, amountReceivedPaise: 10000, discountGivenPaise: 0, paymentMode: 'cash', requestKey: `${run}-inactive-collection` } })
  pass(Boolean(inactivePayment.data.paymentCode), 'inactive subscriber can still pay an existing debt')
  pass((await api('/api/customers', { method: 'PUT', expected: [409], body: { serviceType: 'cable', id: inactiveCustomer.id, name: `${run} INACTIVE`, areaId: cableArea.data.id, phone: '9111111111', stbNumber: `${run}-STB-INACTIVE`, planId: cablePlan.data.id, installationDate: today, status: 'active', restartDate: addDays(today, 10), statusReason: 'QA invalid early restart' } })).status === 409, 'reactivation cannot overlap already billed service')
  await api('/api/customers', { method: 'PUT', expected: [204], body: { serviceType: 'cable', id: inactiveCustomer.id, name: `${run} INACTIVE`, areaId: cableArea.data.id, phone: '9111111111', stbNumber: `${run}-STB-INACTIVE`, planId: cablePlan.data.id, installationDate: today, status: 'active', restartDate: addDays(today, 30), statusReason: 'QA valid restart' } })
  const reactivatedState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(inactiveCustomer.customerCode)}`)).data[0]
  pass(reactivatedState.status === 'active' && reactivatedState.nextBillingStartDate === addDays(today, 30), 'valid reactivation resumes billing after previous coverage')

  const waiverCustomer = await customer('FULL-DISCOUNT')
  const waiverInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: waiverCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  await api('/api/payments', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: waiverCustomer.id, paymentDate: today, amountReceivedPaise: 0, discountGivenPaise: 20000, paymentMode: 'cash', notes: 'QA full waiver', requestKey: `${run}-full-discount` } })
  const waiverRow = (await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(waiverInvoice.data.invoiceCode)}`)).data.items[0]
  const waiverState = (await api(`/api/customers?serviceType=cable&query=${encodeURIComponent(waiverCustomer.customerCode)}`)).data[0]
  pass(waiverRow.status === 'paid' && waiverState.creditBalancePaise === 0, 'full discount can waive an invoice without creating cash or credit')

  const snapshotCustomer = await customer('PRICE-SNAPSHOT')
  const snapshotInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: snapshotCustomer.id, monthsBilled: 1, expectedPeriodStart: today } })
  await api('/api/plans', { method: 'PUT', expected: [204], body: { serviceType: 'cable', id: cablePlan.data.id, name: `${run} Cable 200`, pricePaise: 25000, units: '30 days', isActive: true } })
  const oldSnapshot = await api(`/api/invoices?serviceType=cable&id=${(await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(snapshotInvoice.data.invoiceCode)}`)).data.items[0].id}`)
  pass(oldSnapshot.data.currentPeriodAmountPaise === 20000 && oldSnapshot.data.planName === `${run} Cable 200`, 'plan price change does not rewrite an existing invoice snapshot')
  const newPriceInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: snapshotCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 30) } })
  const newPriceDetail = await api(`/api/invoices?serviceType=cable&id=${(await api(`/api/invoices?serviceType=cable&query=${encodeURIComponent(newPriceInvoice.data.invoiceCode)}`)).data.items[0].id}`)
  pass(newPriceDetail.data.currentPeriodAmountPaise === 25000, 'next renewal uses the newly configured plan price')
  pass((await api('/api/customers', { method: 'PUT', expected: [409], body: { serviceType: 'cable', id: snapshotCustomer.id, name: `${run} PRICE-SNAPSHOT`, areaId: cableArea.data.id, phone: '9000000000', stbNumber: `${run}-STB-PRICE-SNAPSHOT`, planId: cablePlan.data.id, installationDate: addDays(today, 1), status: 'active' } })).status === 409, 'installation date cannot move after billing history begins')
  await api('/api/plans', { method: 'PUT', expected: [204], body: { serviceType: 'cable', id: cablePlan.data.id, name: `${run} Cable 200`, pricePaise: 20000, units: '30 days', isActive: false } })
  pass((await api('/api/invoices', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: snapshotCustomer.id, monthsBilled: 1, expectedPeriodStart: addDays(today, 60) } })).status === 400, 'inactive plan blocks new renewal billing')
  await api('/api/plans', { method: 'PUT', expected: [204], body: { serviceType: 'cable', id: cablePlan.data.id, name: `${run} Cable 200`, pricePaise: 20000, units: '30 days', isActive: true } })
  pass((await api('/api/payments', { method: 'POST', expected: [404], body: { serviceType: 'cable', customerId: broadbandCustomerResult.data.id, paymentDate: today, amountReceivedPaise: 100, discountGivenPaise: 0, paymentMode: 'cash', requestKey: `${run}-cross-service-payment` } })).status === 404, 'cross-service customer payment is blocked')

  const maximumCustomer = await customer('MAX-CYCLES')
  const maximumInvoice = await api('/api/invoices', { method: 'POST', expected: [201], body: { serviceType: 'cable', customerId: maximumCustomer.id, monthsBilled: 24, expectedPeriodStart: today } })
  pass(maximumInvoice.data.periodEnd === addDays(today, 719), 'maximum 24-cycle invoice covers exactly 720 days')
  const overMaximumCustomer = await customer('OVER-MAX')
  pass((await api('/api/invoices', { method: 'POST', expected: [400], body: { serviceType: 'cable', customerId: overMaximumCustomer.id, monthsBilled: 25, expectedPeriodStart: today } })).status === 400, 'more than 24 billing cycles is blocked')
  pass((await api('/api/customers', { method: 'POST', expected: [400], body: { serviceType: 'cable', name: `${run} INVALID-DATE`, areaId: cableArea.data.id, planId: cablePlan.data.id, installationDate: '2025-02-29', openingBalancePaise: 0, openingBalanceType: 'due' } })).status === 400, 'impossible calendar date is blocked')

  const bulkCustomer = await customer('BULK')
  const throughMonth = addDays(today, 45).slice(0, 7)
  const bulk = await api('/api/invoices/bulk', { method: 'POST', expected: [201], body: { serviceType: 'cable', throughMonth, customerIds: [bulkCustomer.id, noPlanCustomer.id] } })
  pass(bulk.data.generated.length === 1 && bulk.data.failed.some((item) => item.customerId === noPlanCustomer.id), 'bulk billing generates eligible customer and reports unavailable setup separately')

  const expense = await api('/api/expenses', { method: 'POST', expected: [201], body: { description: `${run} office expense`, amountPaise: 12345, expenseDate: today, category: 'Office' } })
  created.expenses.push(expense.data.id)
  pass((await api(`/api/expenses?from=${today}&to=${today}&category=Office`)).data.some((item) => item.id === expense.data.id), 'expense date/category filtering')
  await api(`/api/expenses?id=${expense.data.id}&reason=QA%20expense%20correction`, { method: 'DELETE', expected: [204] })
  pass(!(await api(`/api/expenses?from=${today}&to=${today}`)).data.some((item) => item.id === expense.data.id), 'deleted expense leaves active reports')

  const backup = await api('/api/backup')
  pass(backup.data.version === 3 && Array.isArray(backup.data.data.audit_events), 'version 3 backup includes audit events')
  pass(!('admin_auth' in backup.data.data) && !('admin_sessions' in backup.data.data), 'backup excludes authentication secrets and sessions')

  await api('/api/auth/logout', { method: 'POST', expected: [204] })
  cookie = ''
  pass((await api('/api/auth/me', { expected: [401] })).status === 401, 'logout invalidates the active session')

  console.log(`\nDEEP LIVE AUDIT COMPLETE: ${checks} checks, ${findings.length} findings`)
  for (const finding of findings) console.log(`- ${finding.message}: ${finding.evidence}`)
} finally {
  try { await cleanup(previousSettings, previousSequences) } finally { db.close() }
}
