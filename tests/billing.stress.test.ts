import { describe, expect, it } from 'vitest'
import { allocateOldestFirst } from '../src/lib/billing'
import { replayLedger } from '../src/lib/replay'

function random(seed: { value: number }) {
  seed.value = (seed.value * 1664525 + 1013904223) >>> 0
  return seed.value / 0x1_0000_0000
}

describe('billing stress invariants', () => {
  it('keeps allocations within invoice balances across 1,000 payment scenarios', () => {
    const seed = { value: 0x51_7a_42 }
    for (let scenario = 0; scenario < 1_000; scenario += 1) {
      const invoices = Array.from({ length: 10 }, (_, index) => ({
        id: index + 1,
        periodStart: `2026-${String(index + 1).padStart(2, '0')}-01`,
        amountPaise: 10_000 + Math.floor(random(seed) * 20_000),
        createdAt: `2026-${String(index + 1).padStart(2, '0')}-01T00:00:00.000Z`,
      }))
      const payments = Array.from({ length: 15 }, (_, index) => ({
        id: scenario * 100 + index + 1,
        amountReceivedPaise: Math.floor(random(seed) * 40_000),
        discountGivenPaise: 0,
        paymentMode: index % 11 === 0 ? 'system_credit' as const : index % 2 ? 'upi' as const : 'cash' as const,
        createdAt: `2026-${String((index % 10) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
      }))
      const result = replayLedger(Math.floor(random(seed) * 5_000), invoices, payments)
      const allocatedByInvoice = new Map<number, number>()
      for (const allocation of result.allocations) {
        const total = allocation.cashPaise + allocation.discountPaise + allocation.creditPaise
        expect(total).toBeGreaterThan(0)
        allocatedByInvoice.set(allocation.invoiceId, (allocatedByInvoice.get(allocation.invoiceId) ?? 0) + total)
        const invoice = invoices.find((item) => item.id === allocation.invoiceId)!
        const payment = payments.find((item) => item.id === allocation.paymentId)!
        expect(!payment.createdAt || !invoice.createdAt || invoice.createdAt <= payment.createdAt).toBe(true)
      }
      for (const invoice of invoices) expect(allocatedByInvoice.get(invoice.id) ?? 0).toBeLessThanOrEqual(invoice.amountPaise)
      expect(result.paymentStatuses).toHaveLength(payments.length)
      expect(result.invoiceStatuses).toHaveLength(invoices.length)
      expect(result.creditPaise).toBeGreaterThanOrEqual(0)
    }
  })

  it('preserves oldest-first allocation for 100 repeated payment shapes', () => {
    for (let scenario = 0; scenario < 100; scenario += 1) {
      const result = allocateOldestFirst(
        [
          { id: 1, periodStart: '2026-01-01', currentAmountPaise: 10_000, allocatedPaise: 0 },
          { id: 2, periodStart: '2026-02-01', currentAmountPaise: 20_000, allocatedPaise: 0 },
        ],
        scenario * 137 % 30_001,
        0,
        scenario % 13 === 0 ? 250 : 0,
      )
      expect(result.allocations.every((item) => item.invoiceId === 1 || item.invoiceId === 2)).toBe(true)
      expect(result.remainingBalancePaise).toBeGreaterThanOrEqual(0)
      expect(result.remainingCreditPaise).toBeGreaterThanOrEqual(0)
    }
  })

  it('accepts a valid discount without creating credit', () => {
    expect(allocateOldestFirst(
      [{ id: 1, periodStart: '2026-01-01', currentAmountPaise: 10_000, allocatedPaise: 0 }],
      9_000,
      1_000,
      0,
    )).toMatchObject({ remainingBalancePaise: 0, remainingCreditPaise: 0 })
  })
})
