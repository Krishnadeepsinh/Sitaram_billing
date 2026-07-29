import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { createInvoicePeriod, nextEligibleBillingDate } from '../../src/lib/billing.js'
import { parseStrictDate } from '../../src/lib/date.js'
import { database, withWriteTransaction } from '../lib/db.js'
import { methodNotAllowed, sendError } from '../lib/http.js'
import { requireSession } from '../lib/session.js'
import { body, serviceTypeSchema } from '../lib/validation.js'
import { createInvoiceInTransaction, InvoiceRequestError } from '../lib/invoice-service.js'
import { rebuildCustomerLedger } from '../lib/ledger.js'
import { recordAudit } from '../lib/audit.js'
import { recomputeBillingPosition } from '../lib/coverage.js'

const inputSchema = z.object({
  serviceType: serviceTypeSchema, customerId: z.number().int().positive(), monthsBilled: z.number().int().min(1).max(24),
  expectedPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), issuedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  billingMode: z.enum(['normal', 'historical']).default('normal'), historicalReason: z.string().trim().max(250).optional(),
})

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  try {
    if (request.method === 'GET') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const db = database()
      if (request.query.previewCustomerId) {
        const customerId = z.coerce.number().int().positive().parse(request.query.previewCustomerId)
        const monthsBilled = z.coerce.number().int().min(1).max(24).parse(request.query.monthsBilled)
        const periodStart = parseStrictDate(String(request.query.periodStart))
        const billingMode = request.query.billingMode === 'historical' ? 'historical' : 'normal'
        const period = createInvoicePeriod(periodStart, monthsBilled)
        const customer = await db.execute({ sql: `SELECT customers.name, customers.next_billing_start_date AS nextBillingStartDate, customers.opening_balance_paise AS openingBalancePaise, customers.opening_balance_type AS openingBalanceType, plans.name AS planName, plans.price_paise AS pricePaise,
          (SELECT COUNT(*) FROM invoices WHERE customer_id = customers.id AND is_deleted = 0 AND is_merged = 0) AS invoiceCount,
          (SELECT COALESCE(SUM(charges.total - COALESCE(allocations.total, 0)), 0) FROM invoices
            JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
            LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocations ON allocations.invoice_id = invoices.id
            WHERE invoices.customer_id = customers.id AND invoices.is_deleted = 0 AND invoices.is_merged = 0) AS outstandingDuePaise,
          (SELECT MAX(period_end) FROM invoices WHERE customer_id = customers.id AND is_deleted = 0 AND is_merged = 0) AS currentCoverageEnd
          FROM customers LEFT JOIN plans ON plans.id = customers.plan_id WHERE customers.id = ? AND customers.service_type = ? AND customers.is_deleted = 0`, args: [customerId, serviceType] })
        if (!customer.rows[0]) return sendError(response, 404, 'Customer not found.')
        let planName = customer.rows[0].planName; let pricePaise = customer.rows[0].pricePaise
        if (billingMode === 'historical') {
          const historicalPlan = await db.execute({ sql: `SELECT planName, pricePaise FROM (
            SELECT plan_name_snapshot AS planName, price_paise_snapshot AS pricePaise, effective_date AS effectiveDate, created_at AS createdAt FROM customer_plan_history WHERE customer_id = ?
            UNION ALL SELECT NULL, NULL, effective_date, created_at FROM customer_plan_gaps WHERE customer_id = ?
            ) WHERE effectiveDate <= ? ORDER BY effectiveDate DESC, createdAt DESC LIMIT 1`, args: [customerId, customerId, period.periodStart] })
          planName = historicalPlan.rows[0]?.planName ?? null; pricePaise = historicalPlan.rows[0]?.pricePaise ?? null
        }
        const conflict = await db.execute({ sql: `SELECT invoice_code AS invoiceCode, period_start AS periodStart, period_end AS periodEnd FROM invoices WHERE customer_id = ? AND is_deleted = 0 AND is_merged = 0 AND period_start <= ? AND period_end >= ? ORDER BY period_start LIMIT 1`, args: [customerId, period.periodEnd, period.periodStart] })
        const currentChargePaise = Number(pricePaise ?? 0) * monthsBilled
        const openingDuePaise = Number(customer.rows[0].invoiceCount) === 0 && customer.rows[0].openingBalanceType === 'due' ? Number(customer.rows[0].openingBalancePaise) : 0
        const previousDuePaise = Number(customer.rows[0].outstandingDuePaise) + openingDuePaise
        const projectedCoverageEnd = !customer.rows[0].currentCoverageEnd || period.periodEnd > String(customer.rows[0].currentCoverageEnd) ? period.periodEnd : String(customer.rows[0].currentCoverageEnd)
        return response.status(200).json({ customerName: customer.rows[0].name, ...period, planName, pricePaise: Number(pricePaise ?? 0), currentChargePaise, previousDuePaise, totalPayablePaise: currentChargePaise + previousDuePaise, currentCoverageEnd: customer.rows[0].currentCoverageEnd, currentNextBillingDate: customer.rows[0].nextBillingStartDate, nextEligibleDate: nextEligibleBillingDate(projectedCoverageEnd), conflict: conflict.rows[0] ?? null })
      }
      if (request.query.deletePreview) {
        const invoiceId = z.coerce.number().int().positive().parse(request.query.deletePreview)
        const invoice = await db.execute({ sql: `SELECT invoices.invoice_code AS invoiceCode, invoices.customer_id AS customerId, invoices.billing_mode AS billingMode,
          invoices.period_start AS periodStart, invoices.period_end AS periodEnd, customers.next_billing_start_date AS currentNextBillingDate
          FROM invoices JOIN customers ON customers.id = invoices.customer_id WHERE invoices.id = ? AND invoices.service_type = ? AND invoices.is_deleted = 0`, args: [invoiceId, serviceType] })
        if (!invoice.rows[0]) return sendError(response, 404, 'Invoice not found.')
        const payments = await db.execute({ sql: `SELECT DISTINCT payments.id, payments.payment_code AS paymentCode, payments.amount_received_paise AS amountReceivedPaise,
          payments.discount_given_paise AS discountGivenPaise,
          (SELECT COUNT(DISTINCT other.invoice_id) FROM payment_allocations other WHERE other.payment_id = payments.id AND other.is_deleted = 0 AND other.invoice_id <> ?) AS sharedInvoiceCount
          FROM payment_allocations JOIN payments ON payments.id = payment_allocations.payment_id
          WHERE payment_allocations.invoice_id = ? AND payment_allocations.is_deleted = 0 AND payments.is_deleted = 0`, args: [invoiceId, invoiceId] })
        const affectedInvoices = payments.rows.length ? await db.execute({ sql: `SELECT DISTINCT invoices.invoice_code AS invoiceCode FROM payment_allocations
          JOIN invoices ON invoices.id = payment_allocations.invoice_id WHERE payment_allocations.payment_id IN (${payments.rows.map(() => '?').join(',')})
          AND payment_allocations.invoice_id <> ? AND payment_allocations.is_deleted = 0 AND invoices.is_deleted = 0`, args: [...payments.rows.map((row) => row.id), invoiceId] }) : { rows: [] }
        return response.status(200).json({ ...invoice.rows[0], payments: payments.rows, affectedInvoices: affectedInvoices.rows })
      }
      if (request.query.id) {
        const invoiceId = z.coerce.number().int().positive().parse(request.query.id)
        const invoice = await db.execute({ sql: `SELECT invoices.id, invoices.invoice_code AS invoiceCode, invoices.customer_id AS customerId, customers.customer_code AS customerCode,
          invoices.customer_name_snapshot AS customerName, customers.phone, invoices.service_type AS serviceType, invoices.area_name_snapshot AS areaName, invoices.plan_name_snapshot AS planName, invoices.stb_number_snapshot AS stbNumber,
          invoices.period_start AS periodStart, invoices.period_end AS periodEnd, invoices.issued_date AS issuedDate, invoices.months_billed AS monthsBilled,
          invoices.current_period_amount_paise AS currentPeriodAmountPaise, invoices.previous_due_snapshot_paise AS previousDueSnapshotPaise,
          invoices.total_payable_paise AS totalPayablePaise, (SELECT SUM(amount_paise) FROM invoice_charges WHERE invoice_id = invoices.id) AS chargeAmountPaise,
          invoices.due_date AS dueDate, invoices.status, invoices.billing_mode AS billingMode, invoices.historical_reason AS historicalReason
          FROM invoices JOIN customers ON customers.id = invoices.customer_id WHERE invoices.id = ? AND invoices.service_type = ? AND invoices.is_deleted = 0`, args: [invoiceId, serviceType] })
        if (!invoice.rows[0]) return sendError(response, 404, 'Invoice not found.')
        const [charges, allocations, mergeItems, customerDue] = await Promise.all([
          db.execute({ sql: 'SELECT charge_type AS chargeType, description, amount_paise AS amountPaise FROM invoice_charges WHERE invoice_id = ? ORDER BY id', args: [invoiceId] }),
          db.execute({ sql: `SELECT payments.payment_code AS paymentCode, payments.payment_date AS paymentDate, invoices.period_start AS periodStart, invoices.period_end AS periodEnd, invoice_charges.charge_type AS chargeType,
            COALESCE(payment_charge_allocations.amount_cash_paise, payment_allocations.amount_cash_paise) AS cashPaise,
            COALESCE(payment_charge_allocations.amount_discount_paise, payment_allocations.amount_discount_paise) AS discountPaise,
            COALESCE(payment_charge_allocations.amount_credit_paise, payment_allocations.amount_credit_paise) AS creditPaise
            FROM payment_allocations JOIN payments ON payments.id = payment_allocations.payment_id JOIN invoices ON invoices.id = payment_allocations.invoice_id
            LEFT JOIN payment_charge_allocations ON payment_charge_allocations.payment_allocation_id = payment_allocations.id AND payment_charge_allocations.is_deleted = 0
            LEFT JOIN invoice_charges ON invoice_charges.id = payment_charge_allocations.invoice_charge_id
            WHERE payment_allocations.invoice_id = ? AND payment_allocations.is_deleted = 0 AND payments.is_deleted = 0 ORDER BY payments.payment_date, payments.id, invoice_charges.id`, args: [invoiceId] }),
          db.execute({ sql: `SELECT source.invoice_code AS invoiceCode, source.plan_name_snapshot AS planName, source.period_start AS periodStart, source.period_end AS periodEnd, source.current_period_amount_paise AS amountPaise FROM invoice_merge_items JOIN invoices source ON source.id = invoice_merge_items.source_invoice_id WHERE invoice_merge_items.merged_invoice_id = ? ORDER BY invoice_merge_items.sort_order`, args: [invoiceId] }),
          db.execute({ sql: `SELECT COALESCE(SUM(charges.total - COALESCE(allocations.total, 0)), 0) AS value FROM invoices JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocations ON allocations.invoice_id = invoices.id WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0`, args: [invoice.rows[0].customerId] }),
        ])
        const liveBalance = charges.rows.reduce((sum, row) => sum + Number(row.amountPaise), 0) - allocations.rows.reduce((sum, row) => sum + Number(row.cashPaise) + Number(row.discountPaise) + Number(row.creditPaise), 0)
        return response.status(200).json({ ...invoice.rows[0], liveBalancePaise: liveBalance, currentCustomerDuePaise: Number(customerDue.rows[0].value), charges: charges.rows, allocations: allocations.rows, mergeItems: mergeItems.rows })
      }
      const query = typeof request.query.query === 'string' ? `%${request.query.query.trim()}%` : '%'
      const showMerged = request.query.showMerged === '1' ? 1 : 0
      const status = request.query.status === 'paid' || request.query.status === 'partial' || request.query.status === 'unpaid' ? request.query.status : null
      const billingMode = request.query.billingMode === 'normal' || request.query.billingMode === 'historical' ? request.query.billingMode : null
      const areaId = request.query.areaId ? z.coerce.number().int().positive().parse(request.query.areaId) : null
      const from = typeof request.query.from === 'string' && request.query.from ? parseStrictDate(request.query.from) : '0000-01-01'
      const to = typeof request.query.to === 'string' && request.query.to ? parseStrictDate(request.query.to) : '9999-12-31'
      if (from > to) return sendError(response, 400, 'The From date must be on or before the To date.')
      const limit = request.query.limit ? z.coerce.number().int().min(1).max(200).parse(request.query.limit) : 100
      const offset = request.query.offset ? z.coerce.number().int().nonnegative().parse(request.query.offset) : 0
      const result = await db.execute({ sql: `SELECT invoices.id, invoices.invoice_code AS invoiceCode, invoices.customer_id AS customerId,
        invoices.customer_name_snapshot AS customerName, invoices.period_start AS periodStart, invoices.period_end AS periodEnd,
        invoices.issued_date AS issuedDate, invoices.current_period_amount_paise AS currentPeriodAmountPaise, invoices.previous_due_snapshot_paise AS previousDueSnapshotPaise,
        invoices.total_payable_paise AS totalPayablePaise, invoices.status, invoices.due_date AS dueDate, invoices.is_merged AS isMerged, invoices.billing_mode AS billingMode,
        EXISTS(SELECT 1 FROM invoice_merge_items WHERE merged_invoice_id = invoices.id) AS isCombined,
        charges.total AS chargeAmountPaise,
        charges.total - COALESCE(allocations.total, 0) AS balancePaise
        FROM invoices JOIN customers ON customers.id = invoices.customer_id
        JOIN (SELECT invoice_id, SUM(amount_paise) AS total FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
        LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocations ON allocations.invoice_id = invoices.id
        WHERE invoices.service_type = ? AND invoices.is_deleted = 0 AND (? = 1 OR invoices.is_merged = 0)
        AND (? IS NULL OR invoices.status = ?) AND (? IS NULL OR invoices.billing_mode = ?) AND (? IS NULL OR invoices.area_id_snapshot = ?)
        AND invoices.period_start <= ? AND invoices.period_end >= ?
        AND (invoices.invoice_code LIKE ? OR invoices.customer_name_snapshot LIKE ? OR customers.customer_code LIKE ? OR COALESCE(invoices.stb_number_snapshot, '') LIKE ?)
        ORDER BY invoices.period_start DESC, invoices.id DESC LIMIT ? OFFSET ?`, args: [serviceType, showMerged, status, status, billingMode, billingMode, areaId, areaId, to, from, query, query, query, query, limit, offset] })
      const count = await db.execute({ sql: `SELECT COUNT(*) AS value FROM invoices JOIN customers ON customers.id = invoices.customer_id WHERE invoices.service_type = ? AND invoices.is_deleted = 0 AND (? = 1 OR invoices.is_merged = 0)
        AND (? IS NULL OR invoices.status = ?) AND (? IS NULL OR invoices.billing_mode = ?) AND (? IS NULL OR invoices.area_id_snapshot = ?) AND invoices.period_start <= ? AND invoices.period_end >= ?
        AND (invoices.invoice_code LIKE ? OR invoices.customer_name_snapshot LIKE ? OR customers.customer_code LIKE ? OR COALESCE(invoices.stb_number_snapshot, '') LIKE ?)`, args: [serviceType, showMerged, status, status, billingMode, billingMode, areaId, areaId, to, from, query, query, query, query] })
      return response.status(200).json({ items: result.rows, total: Number(count.rows[0].value), limit, offset })
    }
    if (request.method === 'DELETE') {
      const serviceType = serviceTypeSchema.parse(request.query.serviceType)
      const invoiceId = z.coerce.number().int().positive().parse(request.query.id)
      const reason = typeof request.query.reason === 'string' && request.query.reason.trim().length >= 5 ? request.query.reason.trim().slice(0, 250) : 'Deleted by administrator'
      await withWriteTransaction(async (transaction) => {
        const invoice = await transaction.execute({ sql: `SELECT id, customer_id, period_start,
          COALESCE((SELECT amount_paise FROM invoice_charges WHERE invoice_id = invoices.id AND charge_type = 'opening_due'), 0) AS opening_due_paise,
          EXISTS(SELECT 1 FROM invoice_merge_items WHERE merged_invoice_id = invoices.id) AS is_combined
          FROM invoices WHERE id = ? AND service_type = ? AND is_deleted = 0`, args: [invoiceId, serviceType] })
        if (!invoice.rows[0]) throw new InvoiceRequestError(404, 'Invoice not found.')
        const linkedPayments = await transaction.execute({ sql: `SELECT DISTINCT payments.id FROM payment_allocations
          JOIN payments ON payments.id = payment_allocations.payment_id
          WHERE payment_allocations.invoice_id = ? AND payment_allocations.is_deleted = 0 AND payments.is_deleted = 0`, args: [invoiceId] })
        const paymentIds = linkedPayments.rows.map((row) => Number(row.id))
        if (paymentIds.length) {
          const placeholders = paymentIds.map(() => '?').join(',')
          // Remove only this invoice's allocations first. A payment may cover
          // multiple invoices; in that case it must remain live and be
          // replayed against the invoices that still exist. Payments that have
          // no remaining live allocation are the legacy single-invoice case
          // and are removed with the deleted invoice.
          await transaction.execute({ sql: 'UPDATE payment_allocations SET is_deleted = 1 WHERE invoice_id = ? AND is_deleted = 0', args: [invoiceId] })
          await transaction.execute({ sql: `UPDATE payments SET is_deleted = 1 WHERE id IN (${placeholders})
            AND NOT EXISTS (SELECT 1 FROM payment_allocations WHERE payment_allocations.payment_id = payments.id AND payment_allocations.is_deleted = 0)`, args: paymentIds })
        }
        if (Number(invoice.rows[0].is_combined) === 1) {
          await transaction.execute({ sql: 'UPDATE invoices SET is_merged = 0, merged_into_invoice_id = NULL WHERE id IN (SELECT source_invoice_id FROM invoice_merge_items WHERE merged_invoice_id = ?)', args: [invoiceId] })
        }
        await transaction.execute({ sql: 'UPDATE invoices SET is_deleted = 1 WHERE id = ?', args: [invoiceId] })
        let movedOpeningDueToInvoiceId: number | null = null
        const openingDuePaise = Number(invoice.rows[0].opening_due_paise)
        if (openingDuePaise > 0) {
          const target = await transaction.execute({ sql: `SELECT invoices.id FROM invoices
            WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0
            AND NOT EXISTS (SELECT 1 FROM invoice_charges WHERE invoice_charges.invoice_id = invoices.id AND invoice_charges.charge_type = 'opening_due')
            ORDER BY invoices.period_start, invoices.id LIMIT 1`, args: [invoice.rows[0].customer_id] })
          const existingOpeningDue = await transaction.execute({ sql: `SELECT 1 FROM invoices JOIN invoice_charges ON invoice_charges.invoice_id = invoices.id
            WHERE invoices.customer_id = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0 AND invoice_charges.charge_type = 'opening_due' LIMIT 1`, args: [invoice.rows[0].customer_id] })
          if (target.rows[0] && !existingOpeningDue.rows[0]) {
            movedOpeningDueToInvoiceId = Number(target.rows[0].id)
            await transaction.execute({ sql: "UPDATE invoice_charges SET invoice_id = ? WHERE invoice_id = ? AND charge_type = 'opening_due'", args: [movedOpeningDueToInvoiceId, invoiceId] })
            await transaction.execute({ sql: 'UPDATE invoices SET previous_due_snapshot_paise = ?, total_payable_paise = current_period_amount_paise + ? WHERE id = ?', args: [openingDuePaise, openingDuePaise, movedOpeningDueToInvoiceId] })
          }
        }
        await rebuildCustomerLedger(transaction, Number(invoice.rows[0].customer_id))
        await recomputeBillingPosition(transaction, Number(invoice.rows[0].customer_id), String(invoice.rows[0].period_start))
        await recordAudit(transaction, { entityType: 'invoice', entityId: invoiceId, action: 'invoice_deleted', reason, details: { linkedPaymentIds: paymentIds, restoredMergeSources: Number(invoice.rows[0].is_combined) === 1, movedOpeningDueToInvoiceId } })
      })
      return response.status(204).end()
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'DELETE'])
    const input = body(inputSchema, request.body)
    const result = await withWriteTransaction((transaction) => createInvoiceInTransaction(transaction, input))
    return response.status(result.replayed ? 200 : 201).json(result)
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide a valid customer and month count.')
    if (error instanceof InvoiceRequestError) return sendError(response, error.status, error.message)
    console.error('Invoice generation failed', error)
    return sendError(response, 500, 'Unable to generate invoice.')
  }
}
