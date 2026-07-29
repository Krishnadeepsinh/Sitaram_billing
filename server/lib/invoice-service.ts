import { createInvoicePeriod, MAX_BILLING_CYCLES, MAX_MONEY_PAISE, nextEligibleBillingDate } from '../../src/lib/billing.js'
import { parseStrictDate, todayInBusinessTimezone } from '../../src/lib/date.js'
import { recordAudit } from './audit.js'
import { recomputeBillingPosition } from './coverage.js'
import { rebuildCustomerLedger } from './ledger.js'
import type { DatabaseTransaction } from './db.js'

export class InvoiceRequestError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message) }
}

export type CreateInvoiceInput = {
  serviceType: 'cable' | 'broadband'
  customerId: number
  monthsBilled: number
  expectedPeriodStart: string
  periodStart?: string
  issuedDate?: string
  billingMode?: 'normal' | 'historical'
  historicalReason?: string
}

export async function createInvoiceInTransaction(transaction: DatabaseTransaction, input: CreateInvoiceInput) {
  if (!Number.isInteger(input.monthsBilled) || input.monthsBilled < 1 || input.monthsBilled > MAX_BILLING_CYCLES) throw new InvoiceRequestError(400, `Choose between 1 and ${MAX_BILLING_CYCLES} 30-day cycles.`)
  // Keep archived customers in the lookup so we can return a conflict (rather
  // than the generic setup error) when an admin tries to issue a new invoice.
  // Archived records are intentionally retained for financial history.
  const customer = await transaction.execute({ sql: `SELECT customers.*, areas.display_name AS area_name, plans.name AS plan_name, plans.price_paise, plans.is_active AS plan_is_active
    FROM customers JOIN areas ON areas.id = customers.area_id LEFT JOIN plans ON plans.id = customers.plan_id
    WHERE customers.id = ? AND customers.service_type = ?`, args: [input.customerId, input.serviceType] })
  const row = customer.rows[0]
  if (row && Number(row.is_deleted) === 1) throw new InvoiceRequestError(409, 'Archived subscribers cannot receive invoices. Restore the subscriber first.')
  if (!row || !row.installation_date || !row.next_billing_start_date) throw new InvoiceRequestError(400, 'Complete the customer installation and billing setup before invoicing.')

  const billingMode = input.billingMode ?? 'normal'
  const issuedDate = parseStrictDate(input.issuedDate ?? todayInBusinessTimezone())
  const today = todayInBusinessTimezone()
  if (issuedDate > today) throw new InvoiceRequestError(400, 'Invoice date cannot be in the future.')
  const expectedPeriodStart = parseStrictDate(input.expectedPeriodStart)
  const currentNextStart = parseStrictDate(String(row.next_billing_start_date))
  const requestedStart = parseStrictDate(input.periodStart ?? expectedPeriodStart)
  const invoiceCount = await transaction.execute({ sql: 'SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ? AND is_deleted = 0', args: [input.customerId] })
  const hasInvoiceHistory = Number(invoiceCount.rows[0].count) > 0
  if (billingMode === 'normal') {
    if (row.status !== 'active' || !row.plan_id || row.price_paise === null || Number(row.plan_is_active) !== 1) throw new InvoiceRequestError(400, 'Customer must be active and have an active plan before renewal billing.')
    if (expectedPeriodStart !== currentNextStart) {
      const expectedPeriod = createInvoicePeriod(expectedPeriodStart, input.monthsBilled)
      const existing = await transaction.execute({ sql: `SELECT id, invoice_code AS invoiceCode, period_start AS periodStart, period_end AS periodEnd
        FROM invoices WHERE customer_id = ? AND service_type = ? AND period_start = ? AND period_end = ? AND months_billed = ? AND billing_mode = 'normal' AND is_deleted = 0 AND is_merged = 0 LIMIT 1`, args: [input.customerId, input.serviceType, expectedPeriod.periodStart, expectedPeriod.periodEnd, input.monthsBilled] })
      if (existing.rows[0]) return { invoiceId: Number(existing.rows[0].id), invoiceCode: String(existing.rows[0].invoiceCode), periodStart: String(existing.rows[0].periodStart), periodEnd: String(existing.rows[0].periodEnd), nextEligibleDate: nextEligibleBillingDate(String(existing.rows[0].periodEnd)), replayed: true }
      throw new InvoiceRequestError(409, `Billing position changed. The next eligible start date is ${currentNextStart}.`, { nextEligibleDate: currentNextStart })
    }
    if (hasInvoiceHistory && requestedStart < currentNextStart) throw new InvoiceRequestError(409, `Normal renewal cannot start before ${currentNextStart}. Use Missed Previous Period for an older uncovered period.`, { nextEligibleDate: currentNextStart })
  }

  const period = createInvoicePeriod(requestedStart, input.monthsBilled)
  if (billingMode === 'historical') {
    const reason = input.historicalReason?.trim()
    if (!reason || reason.length < 5) throw new InvoiceRequestError(400, 'Enter a clear reason for the missed-period invoice.')
    if (period.periodStart < String(row.installation_date)) throw new InvoiceRequestError(400, `Missed-period billing cannot start before installation on ${row.installation_date}.`)
    if (period.periodEnd > today) throw new InvoiceRequestError(400, 'Missed-period invoices must end today or earlier. Use Normal Renewal for current or future coverage.')
    const status = await transaction.execute({ sql: `SELECT status FROM customer_status_history WHERE customer_id = ? AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`, args: [input.customerId, period.periodStart] })
    const inactiveTransition = await transaction.execute({ sql: `SELECT id FROM customer_status_history WHERE customer_id = ? AND status = 'inactive' AND effective_date > ? AND effective_date <= ? LIMIT 1`, args: [input.customerId, period.periodStart, period.periodEnd] })
    if (status.rows[0]?.status !== 'active' || inactiveTransition.rows[0]) throw new InvoiceRequestError(409, 'This period includes inactive service. Choose an active uncovered period.')
  }

  const exact = await transaction.execute({ sql: `SELECT id, invoice_code AS invoiceCode, period_start AS periodStart, period_end AS periodEnd FROM invoices
    WHERE customer_id = ? AND service_type = ? AND period_start = ? AND period_end = ? AND billing_mode = ? AND is_deleted = 0 AND is_merged = 0 LIMIT 1`, args: [input.customerId, input.serviceType, period.periodStart, period.periodEnd, billingMode] })
  if (exact.rows[0]) return { invoiceId: Number(exact.rows[0].id), invoiceCode: String(exact.rows[0].invoiceCode), periodStart: String(exact.rows[0].periodStart), periodEnd: String(exact.rows[0].periodEnd), nextEligibleDate: nextEligibleBillingDate(String(exact.rows[0].periodEnd)), replayed: true }
  const overlap = await transaction.execute({ sql: `SELECT invoice_code AS invoiceCode, period_start AS periodStart, period_end AS periodEnd FROM invoices
    WHERE customer_id = ? AND is_deleted = 0 AND is_merged = 0 AND period_start <= ? AND period_end >= ? ORDER BY period_start LIMIT 1`, args: [input.customerId, period.periodEnd, period.periodStart] })
  if (overlap.rows[0]) {
    const nextEligibleDate = nextEligibleBillingDate(String(overlap.rows[0].periodEnd))
    throw new InvoiceRequestError(409, `${overlap.rows[0].invoiceCode} already covers ${overlap.rows[0].periodStart} to ${overlap.rows[0].periodEnd}. The next eligible start date is ${nextEligibleDate}.`, { conflict: overlap.rows[0], nextEligibleDate })
  }

  let planId = Number(row.plan_id)
  let planName = String(row.plan_name ?? '')
  let pricePaise = Number(row.price_paise)
  if (billingMode === 'historical') {
    const historicalPlan = await transaction.execute({ sql: `SELECT planId, planName, pricePaise FROM (
      SELECT plan_id AS planId, plan_name_snapshot AS planName, price_paise_snapshot AS pricePaise, effective_date AS effectiveDate, created_at AS createdAt FROM customer_plan_history WHERE customer_id = ?
      UNION ALL SELECT NULL, NULL, NULL, effective_date, created_at FROM customer_plan_gaps WHERE customer_id = ?
      ) WHERE effectiveDate <= ? ORDER BY effectiveDate DESC, createdAt DESC LIMIT 1`, args: [input.customerId, input.customerId, period.periodStart] })
    if (!historicalPlan.rows[0]?.planId) throw new InvoiceRequestError(409, 'No historical plan assignment exists for this date. Correct the customer plan history first.')
    const planTransition = await transaction.execute({ sql: `SELECT 1 FROM (
      SELECT effective_date FROM customer_plan_history WHERE customer_id = ? UNION ALL SELECT effective_date FROM customer_plan_gaps WHERE customer_id = ?
      ) WHERE effective_date > ? AND effective_date <= ? LIMIT 1`, args: [input.customerId, input.customerId, period.periodStart, period.periodEnd] })
    if (planTransition.rows[0]) throw new InvoiceRequestError(409, 'The selected period crosses a plan change. Bill separate 30-day periods that each use one plan price.')
    planId = Number(historicalPlan.rows[0].planId); planName = String(historicalPlan.rows[0].planName); pricePaise = Number(historicalPlan.rows[0].pricePaise)
  }
  const serviceAmount = pricePaise * input.monthsBilled
  if (!Number.isSafeInteger(serviceAmount) || serviceAmount > MAX_MONEY_PAISE) throw new InvoiceRequestError(400, 'The invoice total exceeds the supported business limit.')
  const outstanding = await transaction.execute({ sql: `SELECT COALESCE(SUM(charges.total - COALESCE(allocations.settled, 0)), 0) AS due
    FROM invoices JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
    LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS settled FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocations ON allocations.invoice_id = invoices.id
    WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0`, args: [input.customerId] })
  const openingDue = Number(invoiceCount.rows[0].count) === 0 && row.opening_balance_type === 'due' ? Number(row.opening_balance_paise) : 0
  const previousDue = Number(outstanding.rows[0].due) + openingDue
  const now = new Date().toISOString()
  const sequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['invoice', input.serviceType] })
  const invoiceCode = `INV-${String(sequence.rows[0].last_number).padStart(3, '0')}`
  const inserted = await transaction.execute({ sql: `INSERT INTO invoices (invoice_code, customer_id, service_type, customer_name_snapshot, area_id_snapshot, area_name_snapshot, plan_name_snapshot, stb_number_snapshot, period_start, period_end, issued_date, months_billed, current_period_amount_paise, previous_due_snapshot_paise, total_payable_paise, due_date, status, billing_mode, historical_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, args: [invoiceCode, input.customerId, input.serviceType, row.name, row.area_id, row.area_name, planName, row.stb_number, period.periodStart, period.periodEnd, issuedDate, input.monthsBilled, serviceAmount, previousDue, serviceAmount + previousDue, period.dueDate, serviceAmount + previousDue === 0 ? 'paid' : 'unpaid', billingMode, input.historicalReason?.trim() ?? null, now] })
  const invoiceId = Number(inserted.rows[0].id)
  await transaction.execute({ sql: "INSERT INTO invoice_charges (invoice_id, charge_type, description, amount_paise) VALUES (?, 'service', ?, ?)", args: [invoiceId, `${planName} service charge`, serviceAmount] })
  if (openingDue) await transaction.execute({ sql: "INSERT INTO invoice_charges (invoice_id, charge_type, description, amount_paise) VALUES (?, 'opening_due', 'Opening balance due', ?)", args: [invoiceId, openingDue] })
  const position = await recomputeBillingPosition(transaction, input.customerId)
  if (Number(row.credit_balance_paise) > 0 && previousDue + serviceAmount > 0) {
    const paymentSequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['payment', input.serviceType] })
    const paymentCode = `PAY-${String(paymentSequence.rows[0].last_number).padStart(3, '0')}`
    await transaction.execute({ sql: `INSERT INTO payments (payment_code, customer_id, service_type, customer_code_snapshot, customer_name_snapshot, area_id_snapshot, area_name_snapshot, stb_number_snapshot, payment_date, amount_received_paise, discount_given_paise, payment_mode, notes, resulting_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'system_credit', 'Automatic credit application', 'settled', ?)`, args: [paymentCode, input.customerId, input.serviceType, row.customer_code, row.name, row.area_id, row.area_name, row.stb_number, todayInBusinessTimezone(), now] })
    await rebuildCustomerLedger(transaction, input.customerId)
  }
  await recordAudit(transaction, { entityType: 'invoice', entityId: invoiceId, action: billingMode === 'historical' ? 'historical_invoice_created' : 'invoice_created', reason: input.historicalReason, details: { invoiceCode, planId, planName, issuedDate, periodStart: period.periodStart, periodEnd: period.periodEnd, serviceAmount } })
  return { invoiceId, invoiceCode, periodStart: period.periodStart, periodEnd: period.periodEnd, nextEligibleDate: position.nextBillingStartDate, replayed: false }
}
