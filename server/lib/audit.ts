import type { DatabaseTransaction } from './db.js'

export function recordAudit(transaction: DatabaseTransaction, input: { entityType: 'customer' | 'invoice' | 'payment' | 'expense' | 'plan'; entityId: number; action: string; reason?: string; details?: unknown }) {
  return transaction.execute({
    sql: 'INSERT INTO audit_events (entity_type, entity_id, action, reason, details_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [input.entityType, input.entityId, input.action, input.reason ?? null, JSON.stringify(input.details ?? {}), 'admin', new Date().toISOString()],
  })
}
