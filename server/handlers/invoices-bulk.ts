import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { DateInputError } from '../../src/lib/date.js'
import { billingMonthsThrough, createInvoicePeriod } from '../../src/lib/billing.js'
import { MAX_BILLING_CYCLES } from '../../src/lib/billing.js'
import { withWriteTransaction } from '../lib/db.js'
import { methodNotAllowed, sendError } from '../lib/http.js'
import { createInvoiceInTransaction, InvoiceRequestError } from '../lib/invoice-service.js'
import { requireSession } from '../lib/session.js'
import { body, serviceTypeSchema } from '../lib/validation.js'

const schema = z.object({ serviceType: serviceTypeSchema, throughMonth: z.string().regex(/^\d{4}-\d{2}$/), customerIds: z.array(z.number().int().positive()).optional(), preview: z.boolean().default(false) })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  try {
    const input = body(schema, request.body)
    const result = await withWriteTransaction(async (transaction) => {
      const selected = input.customerIds?.length ? `AND customers.id IN (${input.customerIds.map(() => '?').join(',')})` : ''
      const customers = await transaction.execute({ sql: `SELECT customers.id, customers.customer_code AS customerCode, customers.name AS customerName, customers.next_billing_start_date AS nextBillingStartDate, plans.price_paise AS pricePaise FROM customers JOIN plans ON plans.id = customers.plan_id
        WHERE customers.service_type = ? AND customers.status = 'active' AND customers.is_deleted = 0 AND customers.next_billing_start_date IS NOT NULL AND plans.is_active = 1 ${selected}
        ORDER BY customers.sort_order`, args: [input.serviceType, ...(input.customerIds ?? [])] })
      const generated: Array<Awaited<ReturnType<typeof createInvoiceInTransaction>>> = []; const ready: Array<{ customerId: number; customerCode: string; customerName: string; periodStart: string; periodEnd: string; cycles: number; amountPaise: number }> = []; const skipped: Array<{ customerId: number; customerCode: string; customerName: string; reason: string }> = []; const failed: Array<{ customerId: number; customerCode?: string; customerName?: string; reason: string }> = []
      const foundIds = new Set(customers.rows.map((customer) => Number(customer.id)))
      for (const requestedId of input.customerIds ?? []) if (!foundIds.has(requestedId)) failed.push({ customerId: requestedId, reason: 'Customer is unavailable or missing active billing setup.' })
      for (const customer of customers.rows) {
        const customerId = Number(customer.id)
        const identity = { customerId, customerCode: String(customer.customerCode), customerName: String(customer.customerName) }
        const months = billingMonthsThrough(String(customer.nextBillingStartDate), input.throughMonth)
        if (!months) { skipped.push({ ...identity, reason: 'No complete unbilled 30-day cycle ends within the selected month.' }); continue }
        if (months > MAX_BILLING_CYCLES) { failed.push({ ...identity, reason: `Range is ${months} cycles; generate at most ${MAX_BILLING_CYCLES} at a time.` }); continue }
        if (input.preview) {
          const period = createInvoicePeriod(String(customer.nextBillingStartDate), months)
          const overlap = await transaction.execute({ sql: `SELECT invoice_code AS invoiceCode, period_start AS periodStart, period_end AS periodEnd, status FROM invoices
            WHERE customer_id = ? AND is_deleted = 0 AND is_merged = 0 AND period_start <= ? AND period_end >= ? ORDER BY period_start LIMIT 1`, args: [customerId, period.periodEnd, period.periodStart] })
          if (overlap.rows[0]) failed.push({ ...identity, reason: `${overlap.rows[0].invoiceCode} (${overlap.rows[0].status}) already covers ${overlap.rows[0].periodStart} to ${overlap.rows[0].periodEnd}. Nothing will be created for this customer.` })
          else ready.push({ ...identity, periodStart: period.periodStart, periodEnd: period.periodEnd, cycles: months, amountPaise: Number(customer.pricePaise) * months })
          continue
        }
        try { generated.push(await createInvoiceInTransaction(transaction, { serviceType: input.serviceType, customerId, monthsBilled: months, expectedPeriodStart: String(customer.nextBillingStartDate), billingMode: 'normal' })) }
        catch (error) { if (error instanceof InvoiceRequestError) failed.push({ ...identity, reason: error.message }); else throw error }
      }
      return { generated, ready, skipped, failed }
    })
    return response.status(input.preview ? 200 : 201).json(result)
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof DateInputError) return sendError(response, 400, 'Choose a valid service and bill-through month.')
    if (error instanceof InvoiceRequestError) return sendError(response, error.status, error.message)
    console.error('Bulk billing failed', error)
    return sendError(response, 500, 'Unable to complete bulk billing.')
  }
}
