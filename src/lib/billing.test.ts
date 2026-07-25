import { describe, expect, it } from 'vitest'
import { allocateOldestFirst, billingMonthsThrough, coverageStatus, createInvoicePeriod, customerDueLabel, hasOverlappingInvoice, nextEligibleBillingDate } from './billing'
import { addBillingDays, billingCyclePosition, endOfCalendarMonth, formatBusinessDate, parseStrictDate } from './date'
import { rupeesToPaise } from './money'

describe('billing foundations', () => {
  it('uses unambiguous calendar dates', () => {
    expect(parseStrictDate('07/04/26')).toBe('2026-04-07')
    expect(() => parseStrictDate('31/02/2026')).toThrow()
    expect(endOfCalendarMonth('2028-02')).toBe('2028-02-29')
    expect(formatBusinessDate('2026-04-07')).toBe('07 Apr 2026')
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

  it('derives exact service coverage and the next eligible date', () => {
    expect(createInvoicePeriod('2026-01-01', 1).periodEnd).toBe('2026-01-30')
    expect(nextEligibleBillingDate('2026-01-30')).toBe('2026-01-31')
    expect(coverageStatus(null, '2026-01-15')).toBe('never_billed')
    expect(coverageStatus('2026-01-30', '2026-01-15', '2026-01-20')).toBe('future')
    expect(coverageStatus('2026-01-30', '2026-01-15', '2026-01-01')).toBe('active')
    expect(coverageStatus('2026-01-30', '2026-01-30')).toBe('expiring_today')
    expect(coverageStatus('2026-01-30', '2026-01-31')).toBe('expired')
  })

  it('keeps every cycle at exactly 30 calendar dates across year, leap-day, and month boundaries', () => {
    const starts = ['2025-12-31', '2026-01-01', '2026-02-28', '2028-02-29', '2026-03-31', '2026-04-30']
    for (const start of starts) {
      const period = createInvoicePeriod(start, 1)
      expect(period.periodEnd).toBe(addBillingDays(start, 29))
      expect(period.dueDate).toBe(addBillingDays(start, 36))
      expect(nextEligibleBillingDate(period.periodEnd)).toBe(addBillingDays(start, 30))
    }
    expect(createInvoicePeriod('2026-07-19', 12).periodEnd).toBe('2027-07-13')
    expect(createInvoicePeriod('2026-07-19', 24).periodEnd).toBe('2028-07-07')
    for (const invalid of ['2026-02-31', '2026-00-01', '2026-13-01', '', '7/4/26']) expect(() => parseStrictDate(invalid)).toThrow()
    expect(parseStrictDate('07/04/26')).toBe('2026-04-07')
  })

  it('labels previous, current, and future billing cycles by coverage date', () => {
    expect(billingCyclePosition('2026-06-01', '2026-06-30', '2026-07-19')).toBe('Previous cycle')
    expect(billingCyclePosition('2026-07-01', '2026-07-30', '2026-07-19')).toBe('Current cycle')
    expect(billingCyclePosition('2026-07-31', '2026-08-29', '2026-07-19')).toBe('Next / future cycle')
  })

  it('labels subscriber dues from their actual unpaid invoice cycles', () => {
    const due = (previousDuePaise: number, currentPlanDuePaise: number, futurePlanDuePaise: number) =>
      customerDueLabel({ previousDuePaise, currentPlanDuePaise, futurePlanDuePaise, duePlanPeriodStart: '2026-07-19', duePlanCycleEndStart: '2026-08-18' })
    expect(customerDueLabel({ previousDuePaise: 1000, currentPlanDuePaise: 0, futurePlanDuePaise: 0 })).toBe('Prev Due')
    expect(due(0, 200, 0)).toBe('JUL 26 - AUG 26')
    expect(due(1000, 200, 0)).toBe('Prev Due + JUL 26 - AUG 26')
    expect(due(1000, 200, 200)).toBe('Prev Due + JUL 26 - AUG 26')
  })

  it('rejects invalid cycle counts and discount-created credit', () => {
    expect(() => createInvoicePeriod('2026-01-01', 0)).toThrow()
    expect(() => createInvoicePeriod('2026-01-01', 25)).toThrow()
    expect(() => allocateOldestFirst([{ id: 1, periodStart: '2026-01-01', currentAmountPaise: 10000, allocatedPaise: 0 }], 0, 10001, 0)).toThrow('Discount cannot create customer credit')
  })
})
