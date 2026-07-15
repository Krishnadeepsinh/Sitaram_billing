import { describe, expect, it } from 'vitest'
import { replayLedger } from './replay'

describe('ledger replay', () => {
  it('reallocates later payments after an earlier payment is removed', () => {
    const invoices = [
      { id: 1, periodStart: '2026-01-01', amountPaise: 30000 },
      { id: 2, periodStart: '2026-01-31', amountPaise: 30000 },
    ]
    const result = replayLedger(0, invoices, [{ id: 2, amountReceivedPaise: 30000, discountGivenPaise: 0, paymentMode: 'cash' }])
    expect(result.allocations).toEqual([{ paymentId: 2, invoiceId: 1, cashPaise: 30000, discountPaise: 0, creditPaise: 0 }])
    expect(result.invoiceStatuses).toEqual([{ invoiceId: 1, status: 'paid' }, { invoiceId: 2, status: 'unpaid' }])
  })

  it('applies opening credit through an auditable system payment', () => {
    const result = replayLedger(20000, [{ id: 1, periodStart: '2026-01-01', amountPaise: 20000 }], [{ id: 1, amountReceivedPaise: 0, discountGivenPaise: 0, paymentMode: 'system_credit' }])
    expect(result.allocations[0]).toMatchObject({ cashPaise: 0, discountPaise: 0, creditPaise: 20000 })
    expect(result.creditPaise).toBe(0)
  })
})
