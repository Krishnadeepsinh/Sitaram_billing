# Acceptance Test Report — 19 July 2026

## Scope and environment

- Matrix: supplied A1–W acceptance matrix (174 numbered cases plus the unnumbered O, U, and W combinations).
- Business date/timezone: 19 July 2026, Asia/Kolkata.
- Environments: isolated SQLite browser database and configured Turso cloud database.
- Services repeated independently: Cable and Broadband.
- Test layers: API integration, deterministic ledger/date unit tests, schema constraints, destructive cloud QA audit with cleanup, browser end-user workflows, PDF rendering in Edge/PDFium and Poppler, backup validation, production build/lint/typecheck, and post-test data integrity audit.

## Final result

All supplied cases are resolved and passing under the documented fixed-30-day-cycle rule. No QA records remain in Turso. The isolated browser database and generated QA artifacts were removed after verification.

One expected value in the supplied matrix was corrected: 24 cycles from 19 July 2026 contain 720 inclusive calendar dates and therefore end on **7 July 2028**, not 8 July 2028. The application correctly uses `start + (cycles × 30) − 1 day`.

## Case ledger

| Section | Cases | Result | Primary evidence |
|---|---|---:|---|
| A — Login/security | A1–A8 | PASS | Secure HttpOnly/SameSite session, generic login errors, required fields, rate limit, independent sessions, expiry/logout, React text escaping |
| B — Service isolation | B1–B6 | PASS | Separate Cable/Broadband browser workflows, cross-service API rejection, scoped queries/reports, per-service sequences |
| C — Areas | C1–C7 | PASS | Create/blank/normalize/rename/delete/protect/restore API tests and historical area snapshot regression |
| D — Plans | D1–D8 | PASS | Integer-paise validation, duplicate normalization, price/name snapshots, deactivate/reactivate, browser plan creation |
| E — Customers | E1–E15 | PASS | Complete/incomplete setup, dates, opening due/advance, STB uniqueness, phone search, Gujarati, install/plan history, nullable restart date |
| F — Lifecycle | F1–F8 | PASS | Inactive collection, renewal block, restart validation, archive block, restore/reason/audit retention |
| G — Invoice creation | G1–G11 | PASS | Preview, opening due split, 1/2/12/24 cycles, validation, idempotency, overlap, future renewal, concurrency |
| H — Due buckets | H1–H8 | PASS | Previous/current/future classification, time transitions, independent service/payment status, bucket-sum invariant |
| I — Historical billing | I1–I8 | PASS | Gap/reason/plan-history/status/install/future/overlap rules and safe historical deletion/recalculation |
| J — Payments | J1–J20 | PASS | Cash/UPI, partials, discounts, overpayment/credit, oldest-first, pre-invoice cash, validation, backdate/future, bound idempotency key |
| K — Payment deletion | K1–K6 | PASS | Latest/middle/discount/credit reversal, replay, invalid later discount protection, double-delete safety |
| L — Invoice deletion | L1–L7 | PASS | Latest-only normal renewal, cascade linked payments, shared-payment warning/reversal, opening due restoration, recreation/double-delete |
| M — Merging | M1–M9 | PASS | Valid combined invoice plus cross-customer, repeated, paid, non-consecutive and skipped-middle rejection; pay/delete/report deduplication |
| N — Bulk billing | N1–N11 | PASS | Eligibility/skip/fail partition, setup/status/plan/future rules, 24-cycle cap, idempotent rerun, per-customer next date |
| O — Search/filters | All listed searches and intersections | PASS | Name/code/phone/STB/area/invoice/payment/Gujarati/trim/case/no-match; service scoping; status/area/plan/mode/type/date intersections; invalid ranges |
| P — Reports | P1–P8 | PASS | Cash/UPI/discount, issued basis, corrected overlap-based service basis, outstanding/deleted/merged logic, shared expense policy, complete exports |
| Q — Dashboard/reminders | Q1–Q7 | PASS | Reconciled totals/statuses, expiring/future behavior, honest WhatsApp actions, missing-phone actionable state, invoice PDF share and overdue/expiry text |
| R — Expenses | R1–R6 | PASS | Create/validate/future-date block/soft-delete/audit, delete-and-recreate correction policy, complete CSV |
| S — Settings/PDF/share | S1–S9 | PASS | Saved identity, logo/fallback, Gujarati/long text, complete invoice/receipt content, native share and download+WhatsApp fallback |
| T — Backup | T1–T5 | PASS | Real browser download, 15 business tables, sensitive exclusions, valid-file pass, corrupted-file specific failure |
| U — Date boundaries | All listed starts/invalid inputs | PASS | Year/month/leap boundaries, exact 30 dates, IST conversion, strict ISO or DD/MM parser |
| V — Concurrency/retry | V1–V7 | PASS | Simultaneous invoices, identical/different payment keys, distinct payments, invoice+payment, delete+payment, retry binding, forced-trigger rollback |
| W — Integrity | All listed invariants | PASS | Both isolated and Turso audits: overlaps/bad periods/orphans/over-allocation/duplicate keys/position drift all zero |

## Defects found and fixed in this audit

1. **Production build failure in Gujarati PDF path typing.** Fixed with a narrow structural adapter; production TypeScript build now passes.
2. **Service-period report boundary omission.** An invoice beginning before the selected range but overlapping it was excluded. Reports and trends now use interval overlap (`period_start <= to` and `period_end >= from`).
3. **Unsafe payment idempotency replay.** Reusing a request key with changed customer/date/amount/discount/mode/notes returned the old payment. Retries are now replayed only for an identical payload; mismatches return HTTP 409.
4. **Missing-phone reminder invisibility.** Due/expiring subscribers without a phone were silently omitted. They now appear with “Phone number required” and a disabled “Add phone first” action.
5. **Misleading plan wording.** “Monthly Price”/“Validity” was inconsistent with fixed cycles. The UI now says “30-Day Cycle Price” and “Fixed Cycle Length (Days).”
6. **Live-audit retry fixture mismatch.** The test retried a payment without the original notes, which correctly failed after request binding. The fixture now sends the identical payload.

## Final verification evidence

- `pnpm check`: 7 test files, 48 tests passed; lint passed; production build passed.
- `pnpm audit:live`: 78 destructive Turso checks passed, 0 findings; cleanup completed.
- `pnpm audit:data`: all six integrity counters are zero.
- `pnpm verify:production-env`: production database and session configuration present.
- Browser: all ten application pages loaded without runtime errors; complete Cable and Broadband financial workflows passed.
- Documents: browser-generated Gujarati invoice and receipt rendered correctly in Edge/PDFium and a fresh Poppler render.
- Backup: real JSON download validated; deliberately corrupted backup failed with a specific missing-table error.

