import { describe, expect, it } from 'vitest'
import { allocateOldestFirst, billingMonthsThrough, createInvoicePeriod, hasOverlappingInvoice } from './billing'
import { parseStrictDate } from './date'
import { rupeesToPaise } from './money'

describe('billing foundations', () => {
  it('uses unambiguous calendar dates', () => {
    expect(parseStrictDate('07/04/26')).toBe('2026-04-07')
    expect(() => parseStrictDate('31/02/2026')).toThrow()
  })

  it('converts rupees exactly to paise', () => {
    expect(rupeesToPaise('330.50')).toBe(33050)
    expect(() => rupeesToPaise('1.999')).toThrow()
  })

  it('allocates cash, discount, then credit against oldest invoices', () => {
    const result = allocateOldestFirst([
      { id: 2, periodStart: '2026-05-01', currentAmountPaise: 30000, allocatedPaise: 0 },
      { id: 1, periodStart: '2026-04-01', currentAmountPaise: 20000, allocatedPaise: 0 },
    ], 25000, 5000, 10000)
    expect(result.allocations).toEqual([
      { invoiceId: 1, cashPaise: 20000, discountPaise: 0, creditPaise: 0 },
      { invoiceId: 2, cashPaise: 5000, discountPaise: 5000, creditPaise: 10000 },
    ])
    expect(result.remainingBalancePaise).toBe(10000)
  })

  it('creates consecutive fixed 30-day invoice periods and detects overlap', () => {
    const period = createInvoicePeriod('2026-04-07', 3)
    expect(period).toEqual({ periodStart: '2026-04-07', periodEnd: '2026-07-05', dueDate: '2026-07-12', monthsBilled: 3 })
    expect(hasOverlappingInvoice(period, [{ periodStart: '2026-06-01', periodEnd: '2026-06-30' }])).toBe(true)
    expect(hasOverlappingInvoice(period, [{ periodStart: '2026-07-06', periodEnd: '2026-08-04' }])).toBe(false)
  })

  it('bulk bills only complete cycles through the selected month', () => {
    expect(billingMonthsThrough('2026-04-07', '2026-06')).toBe(2)
    expect(billingMonthsThrough('2026-06-15', '2026-06')).toBe(0)
  })
})
