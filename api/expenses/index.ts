import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { MAX_MONEY_PAISE } from '../../src/lib/billing'
import { DateInputError, parseStrictDate, todayInBusinessTimezone } from '../../src/lib/date'
import { recordAudit } from '../_lib/audit'
import { database, withWriteTransaction } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body } from '../_lib/validation'

const expenseSchema = z.object({ description: z.string().trim().min(1).max(250), amountPaise: z.number().int().positive().max(MAX_MONEY_PAISE), expenseDate: z.string().min(1), category: z.string().trim().min(1).max(80) })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!await requireSession(request, response)) return
  try {
    const db = database()
    if (request.method === 'GET') {
      const from = typeof request.query.from === 'string' && request.query.from ? parseStrictDate(request.query.from) : '0000-01-01'
      const to = typeof request.query.to === 'string' && request.query.to ? parseStrictDate(request.query.to) : '9999-12-31'
      if (from > to) return sendError(response, 400, 'The From date must be on or before the To date.')
      const category = typeof request.query.category === 'string' && request.query.category ? request.query.category : null
      const result = await db.execute({ sql: 'SELECT id, description, amount_paise AS amountPaise, expense_date AS expenseDate, category FROM expenses WHERE is_deleted = 0 AND expense_date BETWEEN ? AND ? AND (? IS NULL OR category = ?) ORDER BY expense_date DESC, id DESC', args: [from, to, category, category] })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'DELETE') {
      const id = z.coerce.number().int().positive().parse(request.query.id)
      const reason = typeof request.query.reason === 'string' && request.query.reason.trim().length >= 5 ? request.query.reason.trim().slice(0, 250) : 'Deleted by administrator'
      await withWriteTransaction(async (transaction) => {
        const result = await transaction.execute({ sql: 'UPDATE expenses SET is_deleted = 1 WHERE id = ? AND is_deleted = 0', args: [id] })
        if (!result.rowsAffected) throw new Error('EXPENSE_MISSING')
        await recordAudit(transaction, { entityType: 'expense', entityId: id, action: 'expense_deleted', reason })
      })
      return response.status(204).end()
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'DELETE'])
    const input = body(expenseSchema, request.body)
    const expenseDate = parseStrictDate(input.expenseDate)
    if (expenseDate > todayInBusinessTimezone()) return sendError(response, 400, 'Expense date cannot be in the future.')
    const id = await withWriteTransaction(async (transaction) => {
      const result = await transaction.execute({ sql: 'INSERT INTO expenses (description, amount_paise, expense_date, category, created_at) VALUES (?, ?, ?, ?, ?)', args: [input.description, input.amountPaise, expenseDate, input.category, new Date().toISOString()] })
      const expenseId = Number(result.lastInsertRowid)
      await recordAudit(transaction, { entityType: 'expense', entityId: expenseId, action: 'expense_created', details: { expenseDate, amountPaise: input.amountPaise, category: input.category } })
      return expenseId
    })
    return response.status(201).json({ id })
  } catch (error) {
    if (error instanceof Error && error.message === 'EXPENSE_MISSING') return sendError(response, 404, 'Expense not found.')
    if (error instanceof z.ZodError || error instanceof DateInputError) return sendError(response, 400, error instanceof DateInputError ? error.message : 'Provide valid expense details and date range.')
    console.error('Expense request failed', error)
    return sendError(response, 500, 'Unable to save expense.')
  }
}
