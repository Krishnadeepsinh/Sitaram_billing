# Sitaram Billing & Records

Production-oriented single-admin billing for Sitaram Cable and Broadband. The application keeps both services isolated while sharing business-wide expenses and settings.

## Requirements

- Node.js 20.12 or newer
- pnpm
- A Turso/LibSQL database
- A Vercel project for production hosting

## Local setup

1. Copy `.env.example` to `.env.local`.
2. For a local database, set `TURSO_DATABASE_URL=file:local.db` and leave `TURSO_AUTH_TOKEN` empty.
3. Generate a random `SESSION_SECRET` containing at least 32 characters.
4. Install and initialize:

```powershell
pnpm install --frozen-lockfile
pnpm migrate
pnpm bootstrap:admin
```

`bootstrap:admin` uses `ADMIN_USERNAME` and `ADMIN_PASSWORD`, and refuses to overwrite an existing administrator.

Run the complete local UI/API environment with `pnpm dev` (or the compatible `pnpm dev:full` alias). It uses `local.db` when `TURSO_DATABASE_URL=file:local.db`; this database is separate from any deployed/cloud database.

## Verification

```powershell
pnpm check
pnpm audit:data
```

`pnpm check` runs unit and LibSQL integration tests, linting, TypeScript compilation, and the optimized Vite build. `pnpm audit:data` performs a read-only integrity audit of the configured database for overlapping service periods, malformed 30-day periods, orphaned or excessive allocations, duplicate retry keys, and billing-position drift.

Before a production migration, validate the server-only environment without printing any secret values:

```powershell
pnpm verify:production-env
```

## Production deployment

1. Create a Turso database and obtain its database URL and auth token.
2. Run `pnpm migrate` against that database.
3. Run `pnpm bootstrap:admin` once with strong administrator credentials.
4. Configure `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and a 32+ character `SESSION_SECRET` in Vercel for Production and Preview.
5. Deploy from the `web` directory.
6. Verify `/api/health`, sign in, create one test customer, generate and reverse a test payment, download a backup, then remove the test records.

Do not expose Turso credentials in variables prefixed with `VITE_`; all database access must remain server-side.

## Backups and recovery

Settings → **Download JSON backup** exports areas, plans, customers, status and plan history, invoices, charges, merge history, payments, allocations, expenses, audit events, and ID sequences. Password hashes, sessions, and login-attempt records are intentionally excluded.

Validate any downloaded backup before storing it off-site:

```powershell
pnpm validate:backup C:\path\to\sitaram-backup-YYYY-MM-DD.json
```

The application is export-only. Restoring data is deliberately a database-administrator operation because an accidental browser import could overwrite the financial ledger.

## Financial correction rules

- Payments are never edited. Reverse and re-enter them.
- Reversing a payment replays all later active payments oldest-first.
- The latest normal renewal or an independent historical-gap correction can be deleted. Linked payments are reversed in the same transaction, then coverage and the ledger are rebuilt.
- Customer deletion is a soft archive; financial history remains.
- Expenses are immutable and soft-deleted when incorrect.
- Money is stored as integer paise and dates as plain `YYYY-MM-DD` business dates.

See [implementation decisions](docs/IMPLEMENTATION_DECISIONS.md) for resolved specification conflicts.

## Open-source document font

PDF documents bundle Noto Sans Gujarati from the official Google Fonts repository under the SIL Open Font License 1.1. This keeps Gujarati subscriber names readable in offline invoice and receipt files.
