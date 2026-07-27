# Product roadmap for a single-admin cable and broadband ledger

## Product rule

The app should shorten the admin's daily work without becoming an ISP network-management suite. Payment confirmation remains manual: a UPI link or QR helps the customer pay, but the admin records the payment only after checking the bank or UPI account. Plan prices remain tax-inclusive, so separate GST calculation is intentionally out of scope.

## What the current product already does well

- Separate service coverage from payment status, with fixed 30-day cycles.
- Support cable and broadband, partial payments, discounts, customer credit, opening balances, cash/UPI references, receipts, invoices, PDF/WhatsApp sharing, reports, expenses, reminders, exports, backups, and an audit trail.
- Protect financial history through idempotency, oldest-first allocation, reversal replay, duplicate UTR checks, and controlled invoice deletion.

These are the hard accounting foundations. The next gains should come from faster daily operation, not a larger accounting model.

## Recommended priorities

### Now — highest value and lowest complexity

1. **Daily action centre**
   - One compact queue for: service ending soon, overdue balances, subscribers due for billing, and incomplete subscriber setup.
   - Each row should provide exactly one primary action: create invoice, record payment, add missing phone/plan, or send a manual reminder.
   - Value: the admin starts from a finite work list instead of checking several pages.

2. **End-of-day collection close**
   - Show today's cash, today's UPI, discounts, reversals, expenses, and expected cash-in-hand, with a printable/exportable daily summary.
   - Keep bank/UPI confirmation manual and label unverified references clearly.
   - Value: faster daily reconciliation and fewer cash/UPI mistakes.

3. **Upcoming invoice preview**
   - On the subscriber record, show the next eligible service date, plan, cycle count, expected amount, prior due, credit, and projected total before creating an invoice.
   - Value: catches plan/date mistakes before they become financial records.

4. **One-click manual WhatsApp actions**
   - Offer Invoice, Receipt, Statement, and Reminder actions from the subscriber and transaction rows.
   - Prefill a short message with customer name, document number, service period, amount, due, and business contact; the admin reviews and sends it.
   - Value: saves repetitive typing without pretending a message or payment was automatically verified.

5. **True global customer finder**
   - Search customer name, code, phone, STB/ONU/router identifier, and area from the top bar; open the subscriber directly.
   - Keep page navigation as a separate small command.
   - Value: removes repeated navigation for the most common admin task.

### Next — valuable after the daily workflow is proven

6. **Overdue ageing and follow-up state**
   - Group outstanding balances into current, 1–30, 31–60, 61–90, and 90+ day buckets.
   - Add only two follow-up fields: last contacted date and a short note.
   - Value: distinguishes recent dues from genuinely risky debt without building a CRM.

7. **Safe spreadsheet import**
   - CSV import with a preview, required-column checks, duplicate phone/STB/customer detection, and an explicit confirmation step.
   - Never silently overwrite existing records.
   - Value: dramatically reduces setup time when moving from BIX42, Vyapar, or handwritten sheets.

8. **Backup health and restore rehearsal**
   - Show last successful backup, its record counts, and validation result. Add a restore dry-run that reports conflicts without changing production data.
   - Value: a backup becomes trustworthy, not merely downloadable.

9. **Subscriber statement**
   - A clean chronological ledger of invoices, payments, discounts, credit, reversals, running balance, and service periods, exportable as PDF.
   - Value: resolves customer questions quickly and provides a single source of truth.

10. **Duplicate and data-quality inbox**
    - Surface missing phone/plan/area, duplicate phone or device identifiers, impossible dates, and stale inactive records.
    - Require explicit review; never auto-merge financial customers.
    - Value: prevents small data issues from becoming billing errors.

### Later — add only when real use proves the need

- Household/account linking when one payer genuinely manages multiple cable or broadband services.
- A lightweight complaint log with open/resolved status and notes.
- Device inventory only if stock, assignment, and return tracking currently costs meaningful time.
- Collector/agent accounts only when more than one person collects money.

## Features to avoid for now

- Automatic UPI settlement or marking invoices paid from a payment link.
- Customer portal or mobile app.
- Network provisioning, suspension automation, RADIUS, or router control.
- Complex inventory, ticketing, sales CRM, or multi-branch accounting.
- Separate GST computation for already tax-inclusive plans.

Each adds operational and support burden without improving this single-admin record-and-receipt workflow today.

## Evidence from peer products

- [BIX42](https://www.bix42.com/home/) focuses cable/ISP work around subscriber billing and collection.
- [Vyapar](https://vyapar.com/invoicing-software) emphasizes clear paid, pending, and partial states plus shareable reminders.
- [Splynx billing](https://splynx.com/isp-billing/) and its [customer billing view](https://wiki.splynx.com/customer_management/customer_billing) combine customer finance history, recurring billing, reminders, and document generation.
- [ISPBox billing](https://ispbox.net/feature/telecom-billing-software) and its [client billing tab](https://ispbox.net/wiki/client-billing-tab) surface balance, upcoming invoices, pending charges, invoices, and payments in one customer context.
- [Powercode](https://www.powercode.com/command/) highlights recurring billing, proration, payment plans, and customer lifecycle automation; only the simple preview and lifecycle cues fit this product.
- [UISP](https://www.uisp.com/) demonstrates unified CRM/billing and tax-inclusive pricing, while its network-management scope is intentionally unnecessary here.
- [CableSMS](https://cablesms.in/) emphasizes spot collection, due reminders, imports, due/collection reports, and PDF/CSV exports.
- [CableNine](https://cablenine.com/) includes auto/manual billing, partial payments, package history, area collection, and complaints.
- [MobiCable](https://play.google.com/store/apps/details?id=com.mb.sp.cableguyV2) promotes a single customer view, monthly billing, part payments, and WhatsApp/SMS receipts.
- [Cable Notes](https://cablenote.com/) and [E-Bill](https://e-bill.in/) reinforce the value of simple collection records, reminders, receipts, and reports for small operators.

The common pattern is clear: the best admin experience is a customer-centred ledger plus a short daily action queue. The large suites add network, inventory, field-force, and portal features because they serve larger teams; copying those modules would make this product slower and harder to operate.

## Success measures

- A returning subscriber can be found and opened in under 10 seconds.
- The admin can finish the due-billing queue without visiting more than one page.
- Recording a verified payment and sharing its receipt takes under 30 seconds.
- Cash and UPI totals can be closed daily without a separate spreadsheet.
- Every financial correction remains auditable and reversible.
