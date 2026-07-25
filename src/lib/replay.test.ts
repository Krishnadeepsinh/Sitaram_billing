import { describe, expect, it } from 'vitest'
import { replayLedger } from './replay'

describe('ledger replay', () => {
  it('reallocates later payments after an earlier payment is removed', () => {
    const invoices = [
      { id: 1, periodStart: '2026-01-01', amountPaise: 30000 },
      { id: 2, periodStart: '2026-01-31', amountPaise: 30000 },
    ]
    const result = replayLedger(0, invoices, [{ id: 2, amountReceivedPaise: 30000, discountGivenPaise: 0, paymentMode: 'cash' }])
    expect(result.allocations).toEqual([{ paymentId: 2, invoiceId: 1, cashPaise: 30000, discountPaise: 0, creditPaise: 0, chargeAllocations: [] }])
    expect(result.invoiceStatuses).toEqual([{ invoiceId: 1, status: 'paid' }, { invoiceId: 2, status: 'unpaid' }])
  })

  it('applies opening credit through an auditable system payment', () => {
    const result = replayLedger(20000, [{ id: 1, periodStart: '2026-01-01', amountPaise: 20000 }], [{ id: 1, amountReceivedPaise: 0, discountGivenPaise: 0, paymentMode: 'system_credit' }])
    expect(result.allocations[0]).toMatchObject({ cashPaise: 0, discountPaise: 0, creditPaise: 20000 })
    expect(result.creditPaise).toBe(0)
  })

  it('does not relabel an old overpayment as cash on a future invoice', () => {
    const result = replayLedger(0, [
      { id: 1, periodStart: '2026-01-01', amountPaise: 10000, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, periodStart: '2026-01-31', amountPaise: 10000, createdAt: '2026-02-01T00:00:00.000Z' },
    ], [
      { id: 1, amountReceivedPaise: 20000, discountGivenPaise: 0, paymentMode: 'cash', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 2, amountReceivedPaise: 0, discountGivenPaise: 0, paymentMode: 'system_credit', createdAt: '2026-02-01T00:00:00.000Z' },
    ])
    expect(result.allocations).toEqual([
      { paymentId: 1, invoiceId: 1, cashPaise: 10000, discountPaise: 0, creditPaise: 0, chargeAllocations: [] },
      { paymentId: 2, invoiceId: 2, cashPaise: 0, discountPaise: 0, creditPaise: 10000, chargeAllocations: [] },
    ])
    expect(result.invoiceStatuses).toEqual([{ invoiceId: 1, status: 'paid' }, { invoiceId: 2, status: 'paid' }])
  })

  it('traces payments across previous due and service charges without double counting', () => {
    const invoice = { id: 1, periodStart: '2026-01-01', amountPaise: 120000, charges: [
      { id: 10, chargeType: 'opening_due' as const, amountPaise: 100000 },
      { id: 11, chargeType: 'service' as const, amountPaise: 20000 },
    ] }
    const result = replayLedger(0, [invoice], [
      { id: 1, amountReceivedPaise: 50000, discountGivenPaise: 0, paymentMode: 'cash' },
      { id: 2, amountReceivedPaise: 50000, discountGivenPaise: 0, paymentMode: 'upi' },
      { id: 3, amountReceivedPaise: 20000, discountGivenPaise: 0, paymentMode: 'cash' },
    ])
    expect(result.allocations.map((allocation) => allocation.chargeAllocations)).toEqual([
      [{ chargeId: 10, cashPaise: 50000, discountPaise: 0, creditPaise: 0 }],
      [{ chargeId: 10, cashPaise: 50000, discountPaise: 0, creditPaise: 0 }],
      [{ chargeId: 11, cashPaise: 20000, discountPaise: 0, creditPaise: 0 }],
    ])
    expect(result.invoiceStatuses).toEqual([{ invoiceId: 1, status: 'paid' }])
  })
})
