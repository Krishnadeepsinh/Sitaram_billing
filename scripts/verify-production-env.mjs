import { loadEnvFile } from 'node:process'

try { loadEnvFile('.env.local') } catch (error) { if (error?.code !== 'ENOENT') throw error }

const failures = []
const url = process.env.TURSO_DATABASE_URL ?? ''
const token = process.env.TURSO_AUTH_TOKEN ?? ''
const sessionSecret = process.env.SESSION_SECRET ?? ''

if (!/^libsql:\/\//.test(url)) failures.push('TURSO_DATABASE_URL must use a production libsql:// database.')
if (token.length < 20 || /replace|your-/i.test(token)) failures.push('TURSO_AUTH_TOKEN is missing or still a placeholder.')
if (sessionSecret.length < 32 || /replace|secret/i.test(sessionSecret)) failures.push('SESSION_SECRET must be a non-placeholder value of at least 32 characters.')

if (failures.length) {
  console.error(`Production environment is not ready:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('Production database and session environment are configured.')
}
