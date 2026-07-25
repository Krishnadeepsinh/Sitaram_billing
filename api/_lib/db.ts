import { createClient } from '@libsql/client'

export type DatabaseTransaction = Awaited<ReturnType<ReturnType<typeof createClient>['transaction']>>

let client: ReturnType<typeof createClient> | undefined
let localWriteTail = Promise.resolve()

export function database() {
  const url = process.env.TURSO_DATABASE_URL
  const authToken = process.env.TURSO_AUTH_TOKEN
  if (!url) throw new Error('TURSO_DATABASE_URL is not configured.')
  if (url !== ':memory:' && !url.startsWith('file:') && !authToken) throw new Error('TURSO_AUTH_TOKEN is not configured.')
  client ??= createClient({ url, authToken })
  return client
}

export function closeDatabase() {
  client?.close()
  client = undefined
}

function isBusy(error: unknown) {
  return error instanceof Error && ('code' in error && error.code === 'SQLITE_BUSY' || /busy|locked|transaction conflict/i.test(error.message))
}

async function runWriteTransaction<T>(work: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let transaction: DatabaseTransaction | undefined
    try {
      transaction = await database().transaction('write')
      const result = await work(transaction)
      await transaction.commit()
      return result
    } catch (error) {
      await transaction?.rollback().catch(() => undefined)
      try { transaction?.close() } catch { /* the original database error is more useful */ }
      if (!isBusy(error) || attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
    } finally {
      try { transaction?.close() } catch { /* commit or rollback already reported the failure */ }
    }
  }
  throw new Error('Unable to start a database transaction.')
}

export async function withWriteTransaction<T>(work: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  const url = process.env.TURSO_DATABASE_URL ?? ''
  if (url !== ':memory:' && !url.startsWith('file:')) return runWriteTransaction(work)
  const previous = localWriteTail
  let release!: () => void
  localWriteTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try { return await runWriteTransaction(work) } finally { release() }
}
