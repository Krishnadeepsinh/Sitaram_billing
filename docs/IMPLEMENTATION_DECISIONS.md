# Implementation decisions

This file records resolutions where the locked specification contains competing requirements.

## Opening due

An opening **Due (Dr)** is stored as a dedicated `opening_due` charge on the customer's first invoice and is also displayed in that invoice's previous-due snapshot. It is not counted as current-period billed revenue. This is the only model that both collects the real carried-forward liability and avoids counting it twice in revenue.

## Invoice correction

Normal renewals can be deleted only when they are the latest coverage record. A historical-gap invoice may be deleted independently because it is explicitly a correction record and must not move current renewal coverage backward. Any linked payment is soft-deleted with all allocations in the same transaction, remaining payments are replayed, and the billing position is derived again from live coverage and activation history.

## Fixed 30-day coverage

One cycle is exactly 30 calendar days: expiry is `start + (30 × cycles) − 1 day`, and the next eligible date is the following day. New customers start today unless installation is later. Existing customers use their derived next eligible date. Overlap protection runs in the write transaction and in a database trigger. Historical invoices require an uncovered past period, continuous active service, a recorded reason, and one unambiguous historical plan price.

Payment status and service status are independent. A paid invoice may represent expired service; an unpaid invoice may represent a future renewal. The UI therefore displays service coverage, payment balance, service expiry, payment due date, and next billing date separately.

## Payment reversal

Reversing a payment replays every remaining payment in creation order and rebuilds allocations, invoice statuses, and customer credit. Historical allocation rows are retained as soft-deleted audit records.

## Competitor-inspired scope

The product adopts fast due-focused lookup, customer history, bulk subscription billing, invoice/date/area filters, cash-versus-UPI reporting, expiring-soon queues, exports, and deliberate manual WhatsApp reminders seen in established billing tools. Inventory, GST automation, payment gateways, collection-agent accounts, customer portals, and automatic messaging remain out of scope because this is a single-admin service ledger and the locked specification does not authorize those systems.

## Bulk bill-through month

Plans are priced in indivisible 30-day cycles, while the final specification also asks bulk billing to stop at a calendar month-end. The implementation bills the maximum number of complete 30-day cycles whose end date is on or before the selected month-end. It never silently prorates a plan or extends an invoice beyond the requested month.
