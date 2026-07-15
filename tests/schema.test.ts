import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { readFile } from 'node:fs/promises'

describe('database integrity', () => {
  it('rejects cross-customer payment allocations', async () => {
    const db = createClient({ url: ':memory:' })
    await db.executeMultiple(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
    const now = new Date().toISOString()
    await db.execute({ sql: "INSERT INTO areas (id, service_type, display_name, normalized_key, sort_order, created_at) VALUES (1, 'cable', 'One', 'one', 1, ?)", args: [now] })
    await db.execute({ sql: "INSERT INTO plans (id, service_type, name, price_paise, sort_order, created_at) VALUES (1, 'cable', 'Plan', 10000, 1, ?)", args: [now] })
    for (const id of [1, 2]) await db.execute({ sql: `INSERT INTO customers (id, customer_code, service_type, name, area_id, plan_id, sort_order, created_at) VALUES (?, ?, 'cable', ?, 1, 1, ?, ?)`, args: [id, `CUST-00${id}`, `Customer ${id}`, id, now] })
    await db.execute({ sql: `INSERT INTO invoices (id, invoice_code, customer_id, service_type, customer_name_snapshot, area_name_snapshot, plan_name_snapshot, period_start, period_end, issued_date, months_billed, current_period_amount_paise, total_payable_paise, due_date, created_at) VALUES (1, 'INV-001', 1, 'cable', 'Customer 1', 'One', 'Plan', '2026-01-01', '2026-01-30', '2026-01-01', 1, 10000, 10000, '2026-02-06', ?)`, args: [now] })
    await db.execute({ sql: `INSERT INTO payments (id, payment_code, customer_id, service_type, payment_date, amount_received_paise, payment_mode, resulting_status, created_at) VALUES (1, 'PAY-001', 2, 'cable', '2026-01-02', 10000, 'cash', 'settled', ?)`, args: [now] })
    await expect(db.execute("INSERT INTO payment_allocations (payment_id, invoice_id, amount_cash_paise) VALUES (1, 1, 10000)")).rejects.toThrow(/different customers/)
    db.close()
  })
})
