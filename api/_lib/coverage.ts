import type { Transaction } from '@libsql/client'
import { addBillingDays } from '../../src/lib/date'

export async function recomputeBillingPosition(transaction: Transaction, customerId: number) {
  const result = await transaction.execute({ sql: `SELECT customers.installation_date AS installationDate,
    (SELECT MAX(period_end) FROM invoices WHERE customer_id = customers.id AND is_deleted = 0 AND is_merged = 0) AS latestPeriodEnd,
    (SELECT effective_date FROM customer_status_history WHERE customer_id = customers.id AND status = 'active' ORDER BY effective_date DESC, id DESC LIMIT 1) AS latestActivation
    FROM customers WHERE customers.id = ?`, args: [customerId] })
  const row = result.rows[0]
  if (!row) throw new Error('Customer not found.')
  const candidates = [row.installationDate, row.latestActivation, row.latestPeriodEnd ? addBillingDays(String(row.latestPeriodEnd), 1) : null]
    .filter((value): value is string => Boolean(value))
  const nextBillingStartDate = candidates.length ? candidates.sort().at(-1)! : null
  await transaction.execute({ sql: 'UPDATE customers SET next_billing_start_date = ? WHERE id = ?', args: [nextBillingStartDate, customerId] })
  return { latestPeriodEnd: row.latestPeriodEnd ? String(row.latestPeriodEnd) : null, nextBillingStartDate }
}
