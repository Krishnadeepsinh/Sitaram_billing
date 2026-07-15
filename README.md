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

Run the complete local UI/API environment with `pnpm dev`. It uses `local.db` when `TURSO_DATABASE_URL=file:local.db`; this database is separate from any deployed/cloud database. `pnpm dev:full` remains available after the directory has been linked to a Vercel project.

## Verification

```powershell
pnpm check
```

This runs unit and LibSQL integration tests, linting, TypeScript compilation, and the optimized Vite build.

## Production deployment

1. Create a Turso database and obtain its database URL and auth token.
2. Run `pnpm migrate` against that database.
3. Run `pnpm bootstrap:admin` once with strong administrator credentials.
4. Configure `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and a 32+ character `SESSION_SECRET` in Vercel for Production and Preview.
5. Deploy from the `web` directory.
6. Verify `/api/health`, sign in, create one test customer, generate and reverse a test payment, download a backup, then remove the test records.

Do not expose Turso credentials in variables prefixed with `VITE_`; all database access must remain server-side.

## Backups and recovery

Settings → **Download JSON backup** exports areas, plans, customers, invoices, charges, merge history, payments, allocations, expenses, and ID sequences. Password hashes and login-attempt records are intentionally excluded.

The application is export-only. Restoring data is deliberately a database-administrator operation because an accidental browser import could overwrite the financial ledger.

## Financial correction rules

- Payments are never edited. Reverse and re-enter them.
- Reversing a payment replays all later active payments oldest-first.
- Only the latest invoice can be deleted. Any payment allocated to it is reversed in the same transaction, then the customer ledger is rebuilt.
- Customer deletion is a soft archive; financial history remains.
- Expenses are immutable and soft-deleted when incorrect.
- Money is stored as integer paise and dates as plain `YYYY-MM-DD` business dates.

See [implementation decisions](docs/IMPLEMENTATION_DECISIONS.md) for resolved specification conflicts.
