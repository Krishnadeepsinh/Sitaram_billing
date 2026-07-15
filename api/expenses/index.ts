import type { VercelRequest, VercelResponse } from '@vercel/node'
import { z } from 'zod'
import { parseStrictDate } from '../../src/lib/date'
import { database } from '../_lib/db'
import { methodNotAllowed, sendError } from '../_lib/http'
import { requireSession } from '../_lib/session'
import { body } from '../_lib/validation'

const expenseSchema = z.object({ description: z.string().trim().min(1).max(250), amountPaise: z.number().int().positive(), expenseDate: z.string().min(1), category: z.string().trim().min(1).max(80) })

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!requireSession(request, response)) return
  try {
    const db = database()
    if (request.method === 'GET') {
      const from = typeof request.query.from === 'string' && request.query.from ? parseStrictDate(request.query.from) : '0000-01-01'
      const to = typeof request.query.to === 'string' && request.query.to ? parseStrictDate(request.query.to) : '9999-12-31'
      const category = typeof request.query.category === 'string' && request.query.category ? request.query.category : null
      const result = await db.execute({ sql: 'SELECT id, description, amount_paise AS amountPaise, expense_date AS expenseDate, category FROM expenses WHERE is_deleted = 0 AND expense_date BETWEEN ? AND ? AND (? IS NULL OR category = ?) ORDER BY expense_date DESC, id DESC', args: [from, to, category, category] })
      return response.status(200).json(result.rows)
    }
    if (request.method === 'DELETE') {
      const id = z.coerce.number().int().positive().parse(request.query.id)
      const result = await db.execute({ sql: 'UPDATE expenses SET is_deleted = 1 WHERE id = ? AND is_deleted = 0', args: [id] })
      if (!result.rowsAffected) return sendError(response, 404, 'Expense not found.')
      return response.status(204).end()
    }
    if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST', 'DELETE'])
    const input = body(expenseSchema, request.body)
    const result = await db.execute({ sql: 'INSERT INTO expenses (description, amount_paise, expense_date, category, created_at) VALUES (?, ?, ?, ?, ?)', args: [input.description, input.amountPaise, parseStrictDate(input.expenseDate), input.category, new Date().toISOString()] })
    return response.status(201).json({ id: Number(result.lastInsertRowid) })
  } catch (error) {
    if (error instanceof z.ZodError) return sendError(response, 400, 'Provide valid expense details.')
    console.error('Expense request failed', error)
    return sendError(response, 500, 'Unable to save expense.')
  }
}
