# Implementation decisions

This file records resolutions where the locked specification contains competing requirements.

## Opening due

An opening **Due (Dr)** is stored as a dedicated `opening_due` charge on the customer's first invoice and is also displayed in that invoice's previous-due snapshot. It is not counted as current-period billed revenue. This is the only model that both collects the real carried-forward liability and avoids counting it twice in revenue.

## Invoice correction

Only the latest invoice for a customer can be deleted. This preserves the canonical next-billing date and prevents gaps behind later invoices. Any payment allocated to that invoice is soft-deleted with all of its allocations in the same transaction, then the remaining customer ledger is replayed. If a linked payment also covered another invoice, that invoice is recalculated to its correct partial or unpaid state.

## Payment reversal

Reversing a payment replays every remaining payment in creation order and rebuilds allocations, invoice statuses, and customer credit. Historical allocation rows are retained as soft-deleted audit records.

## Competitor-inspired scope

The product adopts fast due-focused lookup, customer history, bulk subscription billing, filters, clear reports, and manual WhatsApp document sharing seen in Bix42, Zoho Invoice, and myBillBook. Inventory, GST automation, payment gateways, collection-agent accounts, customer portals, and automatic messaging remain out of scope because this is a single-admin service ledger and the locked specification does not authorize those systems.

## Bulk bill-through month

Plans are priced in indivisible 30-day cycles, while the final specification also asks bulk billing to stop at a calendar month-end. The implementation bills the maximum number of complete 30-day cycles whose end date is on or before the selected month-end. It never silently prorates a plan or extends an invoice beyond the requested month.
