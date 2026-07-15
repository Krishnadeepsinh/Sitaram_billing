import { createClient } from '@libsql/client'

let client: ReturnType<typeof createClient> | undefined

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
