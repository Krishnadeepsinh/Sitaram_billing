import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { DateInputError, endOfCalendarMonth, parseStrictDate } from '../../src/lib/date.js'
import { createInvoicePeriod } from '../../src/lib/billing.js'
import { withWriteTransaction } from '../lib/db.js'
import { methodNotAllowed, sendError } from '../lib/http.js'
import { createInvoiceInTransaction, InvoiceRequestError } from '../lib/invoice-service.js'
import { requireSession } from '../lib/session.js'
import { body, serviceTypeSchema } from '../lib/validation.js'

const schema = z.object({ serviceType: serviceTypeSchema, throughMonth: z.string().regex(/^\d{4}-\d{2}$/), periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), customerIds: z.array(z.number().int().positive()).optional(), preview: z.boolean().default(false) })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  try {
    const input = body(schema, request.body)
    endOfCalendarMonth(input.throughMonth)
    if (input.periodStart && parseStrictDate(input.periodStart).slice(0, 7) !== input.throughMonth) throw new InvoiceRequestError(400, 'Service start date must be within the selected billing month.')
    const result = await withWriteTransaction(async (transaction) => {
      const selected = input.customerIds?.length ? `AND customers.id IN (${input.customerIds.map(() => '?').join(',')})` : ''
      const customers = await transaction.execute({ sql: `SELECT customers.id, customers.customer_code AS customerCode, customers.name AS customerName, customers.status, customers.installation_date AS installationDate, customers.next_billing_start_date AS nextBillingStartDate, customers.plan_id AS planId, plans.price_paise AS pricePaise, plans.is_active AS planIsActive,
        EXISTS(SELECT 1 FROM invoices WHERE invoices.customer_id = customers.id AND invoices.is_deleted = 0 AND invoices.is_merged = 0) AS hasInvoiceHistory FROM customers LEFT JOIN plans ON plans.id = customers.plan_id
        WHERE customers.service_type = ? AND customers.is_deleted = 0 ${selected}
        ORDER BY customers.sort_order`, args: [input.serviceType, ...(input.customerIds ?? [])] })
      const generated: Array<{ invoiceCode: string; customerId: number; customerCode: string; customerName: string; periodStart: string; periodEnd: string; cycles: number; amountPaise: number }> = []; const ready: Array<{ customerId: number; customerCode: string; customerName: string; periodStart: string; periodEnd: string; cycles: number; amountPaise: number }> = []; const skipped: Array<{ customerId: number; customerCode: string; customerName: string; reason: string }> = []; const failed: Array<{ customerId: number; customerCode?: string; customerName?: string; reason: string }> = []
      const foundIds = new Set(customers.rows.map((customer) => Number(customer.id)))
      for (const requestedId of input.customerIds ?? []) if (!foundIds.has(requestedId)) failed.push({ customerId: requestedId, reason: 'Customer is unavailable or missing active billing setup.' })
      for (const customer of customers.rows) {
        const customerId = Number(customer.id)
        const identity = { customerId, customerCode: String(customer.customerCode), customerName: String(customer.customerName) }
        if (customer.status !== 'active') { failed.push({ ...identity, reason: 'Subscriber is inactive. Reactivate the subscriber before billing.' }); continue }
        if (!customer.installationDate || !customer.nextBillingStartDate) { failed.push({ ...identity, reason: 'Complete the customer installation and billing setup before invoicing.' }); continue }
        if (!customer.planId || customer.pricePaise === null || Number(customer.planIsActive) !== 1) { failed.push({ ...identity, reason: 'Customer must have an active plan before renewal billing.' }); continue }
        const nextBillingStartDate = String(customer.nextBillingStartDate)
        const hasInvoiceHistory = Number(customer.hasInvoiceHistory) === 1
        const periodStart = input.periodStart ?? (hasInvoiceHistory ? nextBillingStartDate : `${input.throughMonth}-01`)
        if (hasInvoiceHistory && periodStart !== nextBillingStartDate) { skipped.push({ ...identity, reason: `This customer has previous billing, so service must continue from ${nextBillingStartDate}.` }); continue }
        if (periodStart.slice(0, 7) !== input.throughMonth) { skipped.push({ ...identity, reason: `The next 30-day service period starts on ${nextBillingStartDate}. Select ${nextBillingStartDate.slice(0, 7)} to bill this customer.` }); continue }
        const months = 1
        if (input.preview) {
          const period = createInvoicePeriod(periodStart, months)
          const overlap = await transaction.execute({ sql: `SELECT invoice_code AS invoiceCode, period_start AS periodStart, period_end AS periodEnd, status FROM invoices
            WHERE customer_id = ? AND is_deleted = 0 AND is_merged = 0 AND period_start <= ? AND period_end >= ? ORDER BY period_start LIMIT 1`, args: [customerId, period.periodEnd, period.periodStart] })
          if (overlap.rows[0]) failed.push({ ...identity, reason: `${overlap.rows[0].invoiceCode} (${overlap.rows[0].status}) already covers ${overlap.rows[0].periodStart} to ${overlap.rows[0].periodEnd}. Nothing will be created for this customer.` })
          else ready.push({ ...identity, periodStart: period.periodStart, periodEnd: period.periodEnd, cycles: months, amountPaise: Number(customer.pricePaise) * months })
          continue
        }
        try {
          const created = await createInvoiceInTransaction(transaction, { serviceType: input.serviceType, customerId, monthsBilled: months, expectedPeriodStart: nextBillingStartDate, periodStart, billingMonth: input.throughMonth, billingMode: 'normal' })
          generated.push({ ...identity, invoiceCode: created.invoiceCode, periodStart: created.periodStart, periodEnd: created.periodEnd, cycles: months, amountPaise: Number(customer.pricePaise) * months })
        }
        catch (error) { if (error instanceof InvoiceRequestError) failed.push({ ...identity, reason: error.message }); else throw error }
      }
      return { generated, ready, skipped, failed }
    })
    return response.status(input.preview ? 200 : 201).json(result)
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof DateInputError) return sendError(response, 400, 'Choose a valid billing month and service start date.')
    if (error instanceof InvoiceRequestError) return sendError(response, error.status, error.message)
    console.error('Bulk billing failed', error)
    return sendError(response, 500, 'Unable to complete bulk billing.')
  }
}
