import { createClient } from '@libsql/client'
import { readFile } from 'node:fs/promises'
import { loadEnvFile } from 'node:process'

try { loadEnvFile('.env.local') } catch (error) { if (error?.code !== 'ENOENT') throw error }

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } = process.env
if (!url || (!url.startsWith('file:') && !authToken)) throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before migrating.')
const client = createClient({ url, authToken })
await client.executeMultiple(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
await client.close()
console.log('Database schema applied successfully.')
