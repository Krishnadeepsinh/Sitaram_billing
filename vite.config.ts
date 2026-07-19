import { existsSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

if (process.env.NODE_ENV !== 'production' && existsSync('.env.local')) process.loadEnvFile('.env.local')

function localApi(): Plugin {
  const routes: Record<string, string> = {
    '/api/health': '/api/health.ts', '/api/auth/login': '/api/auth/login.ts', '/api/auth/logout': '/api/auth/logout.ts', '/api/auth/me': '/api/auth/me.ts', '/api/auth/password': '/api/auth/password.ts',
    '/api/areas': '/api/areas/index.ts', '/api/plans': '/api/plans/index.ts', '/api/customers': '/api/customers/index.ts', '/api/invoices': '/api/invoices/index.ts', '/api/invoices/bulk': '/api/invoices/bulk.ts', '/api/invoices/merge': '/api/invoices/merge.ts',
    '/api/payments': '/api/payments/index.ts', '/api/expenses': '/api/expenses/index.ts', '/api/reports': '/api/reports/index.ts', '/api/settings': '/api/settings/index.ts', '/api/backup': '/api/backup.ts',
  }
  return { name: 'local-vercel-api', apply: 'serve', configureServer(server) { server.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost'); const modulePath = routes[url.pathname]
    if (!modulePath) return next()
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      Object.assign(request, { query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : undefined })
      Object.assign(response, {
        status(code: number) { response.statusCode = code; return response },
        json(value: unknown) { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); return response },
      })
      const loaded = await server.ssrLoadModule(modulePath)
      await loaded.default(request, response)
    } catch (error) {
      server.config.logger.error(error instanceof Error ? error.stack ?? error.message : String(error))
      if (!response.headersSent) { response.statusCode = 500; response.setHeader('Content-Type', 'application/json; charset=utf-8') }
      if (!response.writableEnded) response.end(JSON.stringify({ error: 'Local API failed. Check the development server output.' }))
    }
  }) } }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localApi()],
  build: { chunkSizeWarningLimit: 1200 }, // PDF + embedded Gujarati font are isolated in an on-demand document chunk.
})
