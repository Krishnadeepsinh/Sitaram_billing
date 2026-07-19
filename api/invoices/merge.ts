import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { addBillingDays, todayInBusinessTimezone } from '../../src/lib/date'
import { recordAudit } from '../_lib/audit'
import { withWriteTransaction } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body, serviceTypeSchema } from '../_lib/validation'

const schema = z.object({ serviceType: serviceTypeSchema, invoiceIds: z.array(z.number().int().positive()).min(2).max(24) })
class MergeRequestError extends Error { constructor(public status: number, message: string) { super(message) } }

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  try {
    const input = body(schema, request.body)
    const ids = [...new Set(input.invoiceIds)]
    if (ids.length < 2) return sendError(response, 400, 'Choose at least two different invoices.')
    const result = await withWriteTransaction(async (transaction) => {
      const placeholders = ids.map(() => '?').join(',')
      const sources = await transaction.execute({ sql: `SELECT invoices.*, COALESCE(charges.service, 0) AS serviceAmount, COALESCE(charges.opening, 0) AS openingAmount,
        COALESCE(allocations.total, 0) AS allocated FROM invoices
        LEFT JOIN (SELECT invoice_id, SUM(CASE WHEN charge_type = 'service' THEN amount_paise ELSE 0 END) AS service, SUM(CASE WHEN charge_type = 'opening_due' THEN amount_paise ELSE 0 END) AS opening FROM invoice_charges GROUP BY invoice_id) charges ON charges.invoice_id = invoices.id
        LEFT JOIN (SELECT invoice_id, SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) AS total FROM payment_allocations WHERE is_deleted = 0 GROUP BY invoice_id) allocations ON allocations.invoice_id = invoices.id
        WHERE invoices.id IN (${placeholders}) AND invoices.service_type = ? AND invoices.is_deleted = 0 AND invoices.is_merged = 0 ORDER BY invoices.period_start, invoices.id`, args: [...ids, input.serviceType] })
      if (sources.rows.length !== ids.length) throw new MergeRequestError(404, 'One or more invoices are unavailable.')
      const customerId = Number(sources.rows[0].customer_id)
      if (sources.rows.some((row) => Number(row.customer_id) !== customerId)) throw new MergeRequestError(400, 'Merged invoices must belong to the same customer.')
      const customer = await transaction.execute({ sql: 'SELECT is_deleted FROM customers WHERE id = ?', args: [customerId] })
      if (Number(customer.rows[0]?.is_deleted) === 1) throw new MergeRequestError(409, 'Archived subscribers cannot receive merged invoices. Restore the subscriber first.')
      if (sources.rows.some((row) => Number(row.allocated) > 0)) throw new MergeRequestError(409, 'Only fully unpaid invoices can be merged.')
      for (let index = 1; index < sources.rows.length; index += 1) if (String(sources.rows[index].period_start) !== addBillingDays(String(sources.rows[index - 1].period_end), 1)) throw new MergeRequestError(409, 'Only consecutive invoice periods can be merged. Remove gaps from the selection.')
      const between = await transaction.execute({ sql: `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ? AND is_deleted = 0 AND is_merged = 0 AND period_start >= ? AND period_end <= ?`, args: [customerId, sources.rows[0].period_start, sources.rows.at(-1)!.period_end] })
      if (Number(between.rows[0].count) !== ids.length) throw new MergeRequestError(409, 'Select every invoice between the first and last period before merging.')
      const serviceAmount = sources.rows.reduce((sum, row) => sum + Number(row.serviceAmount), 0)
      const openingAmount = sources.rows.reduce((sum, row) => sum + Number(row.openingAmount), 0)
      const sequence = await transaction.execute({ sql: 'INSERT INTO id_sequences (entity_type, service_type, last_number) VALUES (?, ?, 1) ON CONFLICT(entity_type, service_type) DO UPDATE SET last_number = last_number + 1 RETURNING last_number', args: ['invoice', input.serviceType] })
      const invoiceCode = `INV-${String(sequence.rows[0].last_number).padStart(3, '0')}`
      const first = sources.rows[0]; const last = sources.rows[sources.rows.length - 1]; const now = new Date().toISOString()
      const merged = await transaction.execute({ sql: `INSERT INTO invoices (invoice_code, customer_id, service_type, customer_name_snapshot, area_id_snapshot, area_name_snapshot, plan_name_snapshot, stb_number_snapshot, period_start, period_end, issued_date, months_billed, current_period_amount_paise, previous_due_snapshot_paise, total_payable_paise, due_date, is_combined, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'Multiple plans', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) RETURNING id`, args: [invoiceCode, customerId, input.serviceType, first.customer_name_snapshot, first.area_id_snapshot, first.area_name_snapshot, first.stb_number_snapshot, first.period_start, last.period_end, todayInBusinessTimezone(), sources.rows.reduce((sum, row) => sum + Number(row.months_billed), 0), serviceAmount, openingAmount, serviceAmount + openingAmount, last.due_date, now] })
      const mergedId = Number(merged.rows[0].id)
      await transaction.execute({ sql: "INSERT INTO invoice_charges (invoice_id, charge_type, description, amount_paise) VALUES (?, 'service', 'Merged service charges', ?)", args: [mergedId, serviceAmount] })
      if (openingAmount) await transaction.execute({ sql: "INSERT INTO invoice_charges (invoice_id, charge_type, description, amount_paise) VALUES (?, 'opening_due', 'Opening balance due', ?)", args: [mergedId, openingAmount] })
      for (const [index, source] of sources.rows.entries()) {
        await transaction.execute({ sql: 'INSERT INTO invoice_merge_items (merged_invoice_id, source_invoice_id, sort_order) VALUES (?, ?, ?)', args: [mergedId, source.id, index + 1] })
        await transaction.execute({ sql: 'UPDATE invoices SET is_merged = 1, merged_into_invoice_id = ? WHERE id = ?', args: [mergedId, source.id] })
      }
      await recordAudit(transaction, { entityType: 'invoice', entityId: mergedId, action: 'invoices_merged', details: { sourceInvoiceIds: ids, invoiceCode } })
      return { invoiceId: mergedId, invoiceCode }
    })
    return response.status(201).json(result)
  } catch (error) {
    if (error instanceof MergeRequestError) return sendError(response, error.status, error.message)
    if (error instanceof z.ZodError) return sendError(response, 400, 'Choose valid invoices to merge.')
    console.error('Invoice merge failed', error)
    return sendError(response, 500, 'Unable to merge invoices.')
  }
}
