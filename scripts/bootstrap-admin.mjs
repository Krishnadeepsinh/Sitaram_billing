import bcrypt from 'bcryptjs'
import { createClient } from '@libsql/client'
import { loadEnvFile } from 'node:process'

try { loadEnvFile('.env.local') } catch (error) { if (error?.code !== 'ENOENT') throw error }

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken, ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = process.env
if (!url || (!url.startsWith('file:') && !authToken) || !username || !password) throw new Error('Set TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (for remote databases), ADMIN_USERNAME, and ADMIN_PASSWORD.')
if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.')
const client = createClient({ url, authToken })
const exists = await client.execute('SELECT id FROM admin_auth WHERE id = 1')
if (exists.rows[0]) throw new Error('Admin account already exists. Use the password-change flow instead.')
await client.execute({ sql: 'INSERT INTO admin_auth (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)', args: [username, await bcrypt.hash(password, 12), new Date().toISOString()] })
await client.close()
console.log('Admin account created.')
