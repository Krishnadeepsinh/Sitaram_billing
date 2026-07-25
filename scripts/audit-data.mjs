import { createClient } from '@libsql/client'
import { loadEnvFile } from 'node:process'

try { loadEnvFile('.env.local') } catch (error) { if (error?.code !== 'ENOENT') throw error }
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
const checks = {
  overlaps: `SELECT COUNT(*) count FROM invoices a JOIN invoices b ON a.customer_id = b.customer_id AND a.id < b.id
    AND a.is_deleted = 0 AND b.is_deleted = 0 AND a.is_merged = 0 AND b.is_merged = 0
    AND a.period_start <= b.period_end AND a.period_end >= b.period_start`,
  badPeriods: `SELECT COUNT(*) count FROM invoices WHERE is_deleted = 0
    AND julianday(period_end) - julianday(period_start) + 1 <> months_billed * 30`,
  orphanAllocations: `SELECT COUNT(*) count FROM payment_allocations pa
    LEFT JOIN payments p ON p.id = pa.payment_id LEFT JOIN invoices i ON i.id = pa.invoice_id
    WHERE pa.is_deleted = 0 AND (p.id IS NULL OR i.id IS NULL OR p.customer_id <> i.customer_id)`,
  overallocated: `SELECT COUNT(*) count FROM (SELECT i.id, COALESCE(SUM(c.amount_paise), 0) charge,
    COALESCE((SELECT SUM(amount_cash_paise + amount_discount_paise + amount_credit_paise) FROM payment_allocations pa WHERE pa.invoice_id = i.id AND pa.is_deleted = 0), 0) settled
    FROM invoices i JOIN invoice_charges c ON c.invoice_id = i.id WHERE i.is_deleted = 0 GROUP BY i.id HAVING settled > charge)`,
  duplicateRequestKeys: `SELECT COUNT(*) count FROM (SELECT service_type, request_key FROM payments
    WHERE request_key IS NOT NULL GROUP BY service_type, request_key HAVING COUNT(*) > 1)`,
  billingPositionDrift: `SELECT COUNT(*) count FROM customers c WHERE c.installation_date IS NOT NULL AND (
    ((SELECT MAX(period_end) FROM invoices i WHERE i.customer_id = c.id AND i.is_deleted = 0 AND i.is_merged = 0) IS NOT NULL
      AND c.next_billing_start_date <> MAX(c.installation_date,
        COALESCE((SELECT MAX(effective_date) FROM customer_status_history h WHERE h.customer_id = c.id AND h.status = 'active'), c.installation_date),
        date((SELECT MAX(period_end) FROM invoices i WHERE i.customer_id = c.id AND i.is_deleted = 0 AND i.is_merged = 0), '+1 day')))
    OR ((SELECT MAX(period_end) FROM invoices i WHERE i.customer_id = c.id AND i.is_deleted = 0 AND i.is_merged = 0) IS NULL
      AND c.next_billing_start_date < MAX(c.installation_date,
        COALESCE((SELECT MAX(effective_date) FROM customer_status_history h WHERE h.customer_id = c.id AND h.status = 'active'), c.installation_date))))`,
}
const results = {}
for (const [name, sql] of Object.entries(checks)) results[name] = Number((await db.execute(sql)).rows[0].count)
db.close()
console.log(JSON.stringify(results, null, 2))
if (Object.values(results).some(Boolean)) process.exitCode = 1
