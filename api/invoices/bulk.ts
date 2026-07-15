import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { billingMonthsThrough } from '../../src/lib/billing'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { createInvoiceInTransaction, InvoiceRequestError } from '../_lib/invoice-service'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'

const schema = z.object({ serviceType: serviceTypeSchema, throughMonth: z.string().regex(/^\d{4}-\d{2}$/), customerIds: z.array(z.number().int().positive()).optional() })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  try {
    const input = body(schema, request.body)
    const transaction = await database().transaction('write')
    try {
      const selected = input.customerIds?.length ? `AND customers.id IN (${input.customerIds.map(() => '?').join(',')})` : ''
      const customers = await transaction.execute({ sql: `SELECT customers.id, customers.next_billing_start_date AS nextBillingStartDate FROM customers JOIN plans ON plans.id = customers.plan_id
        WHERE customers.service_type = ? AND customers.status = 'active' AND customers.is_deleted = 0 AND customers.next_billing_start_date IS NOT NULL AND plans.is_active = 1 ${selected}
        ORDER BY customers.sort_order`, args: [input.serviceType, ...(input.customerIds ?? [])] })
      const generated = []; const skipped = []
      for (const customer of customers.rows) {
        const customerId = Number(customer.id)
        const months = billingMonthsThrough(String(customer.nextBillingStartDate), input.throughMonth)
        if (!months) { skipped.push(customerId); continue }
        generated.push(await createInvoiceInTransaction(transaction, { serviceType: input.serviceType, customerId, monthsBilled: months }))
      }
      await transaction.commit()
      return response.status(201).json({ generated, skipped })
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Choose a valid service and bill-through month.')
    if (error instanceof InvoiceRequestError) return sendError(response, error.status, error.message)
    console.error('Bulk billing failed', error)
    return sendError(response, 500, 'Unable to complete bulk billing.')
  }
}
