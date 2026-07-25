import type { VercelRequest, VercelResponse } from '@vercel/node'
import areas from '../server/handlers/areas.js'
import audit from '../server/handlers/audit.js'
import backup from '../server/handlers/backup.js'
import authLogin from '../server/handlers/auth-login.js'
import authLogout from '../server/handlers/auth-logout.js'
import authMe from '../server/handlers/auth-me.js'
import authPassword from '../server/handlers/auth-password.js'
import customers from '../server/handlers/customers.js'
import expenses from '../server/handlers/expenses.js'
import health from '../server/handlers/health.js'
import invoices from '../server/handlers/invoices.js'
import invoicesBulk from '../server/handlers/invoices-bulk.js'
import invoicesMerge from '../server/handlers/invoices-merge.js'
import payments from '../server/handlers/payments.js'
import plans from '../server/handlers/plans.js'
import reports from '../server/handlers/reports.js'
import settings from '../server/handlers/settings.js'

type Handler = (request: VercelRequest, response: VercelResponse) => unknown

const handlers: Record<string, Handler> = {
  areas,
  audit,
  backup,
  'auth/login': authLogin,
  'auth/logout': authLogout,
  'auth/me': authMe,
  'auth/password': authPassword,
  customers,
  expenses,
  health,
  invoices,
  'invoices/bulk': invoicesBulk,
  'invoices/merge': invoicesMerge,
  payments,
  plans,
  reports,
  settings,
}

export default function handler(request: VercelRequest, response: VercelResponse) {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/^\/api\/?/, '').replace(/\/$/, '')
  const rewrittenPath = typeof request.query.route === 'string' ? request.query.route : pathname
  const target = handlers[rewrittenPath]
  if (!target) return response.status(404).json({ error: 'API route not found.' })
  return target(request, response)
}
