import { addBillingDays, parseStrictDate } from './date'

export type InvoiceBalance = { id: number; periodStart: string; currentAmountPaise: number; allocatedPaise: number }
export type Allocation = { invoiceId: number; cashPaise: number; discountPaise: number; creditPaise: number }

export type InvoicePeriod = { periodStart: string; periodEnd: string; dueDate: string; monthsBilled: number }

export function createInvoicePeriod(nextBillingStartDate: string, monthsBilled: number): InvoicePeriod {
  if (!Number.isInteger(monthsBilled) || monthsBilled < 1) throw new Error('Choose at least one billing month.')
  const periodStart = parseStrictDate(nextBillingStartDate)
  const periodEnd = addBillingDays(periodStart, monthsBilled * 30 - 1)
  return { periodStart, periodEnd, dueDate: addBillingDays(periodEnd, 7), monthsBilled }
}

export function hasOverlappingInvoice(period: Pick<InvoicePeriod, 'periodStart' | 'periodEnd'>, existingPeriods: Array<Pick<InvoicePeriod, 'periodStart' | 'periodEnd'>>) {
  return existingPeriods.some((existing) => period.periodStart <= existing.periodEnd && period.periodEnd >= existing.periodStart)
}

export function billingMonthsThrough(nextBillingStartDate: string, throughMonth: string): number {
  if (!/^\d{4}-\d{2}$/.test(throughMonth)) throw new Error('Choose a valid bill-through month.')
  const start = parseStrictDate(nextBillingStartDate)
  const [year, month] = throughMonth.split('-').map(Number)
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const [sy, sm, sd] = start.split('-').map(Number)
  const days = Math.floor((Date.parse(`${monthEnd}T00:00:00Z`) - Date.UTC(sy, sm - 1, sd)) / 86_400_000) + 1
  return Math.max(0, Math.floor(days / 30))
}

export function allocateOldestFirst(
  invoices: InvoiceBalance[],
  cashPaise: number,
  discountPaise: number,
  creditPaise: number,
): { allocations: Allocation[]; remainingCreditPaise: number; remainingBalancePaise: number } {
  if (cashPaise < 0 || discountPaise < 0 || creditPaise < 0) throw new Error('Allocation sources cannot be negative.')
  let cash = cashPaise
  let discount = discountPaise
  let credit = creditPaise
  const allocations: Allocation[] = []
  for (const invoice of [...invoices].sort((left, right) => left.periodStart.localeCompare(right.periodStart))) {
    let remaining = invoice.currentAmountPaise - invoice.allocatedPaise
    if (remaining <= 0) continue
    const cashUsed = Math.min(cash, remaining)
    cash -= cashUsed
    remaining -= cashUsed
    const discountUsed = Math.min(discount, remaining)
    discount -= discountUsed
    remaining -= discountUsed
    const creditUsed = Math.min(credit, remaining)
    credit -= creditUsed
    if (cashUsed || discountUsed || creditUsed) allocations.push({ invoiceId: invoice.id, cashPaise: cashUsed, discountPaise: discountUsed, creditPaise: creditUsed })
  }
  if (discount > 0) throw new Error('Discount cannot create customer credit.')
  return {
    allocations,
    remainingCreditPaise: cash + credit,
    remainingBalancePaise: invoices.reduce((total, invoice) => total + Math.max(0, invoice.currentAmountPaise - invoice.allocatedPaise), 0) - allocations.reduce((total, allocation) => total + allocation.cashPaise + allocation.discountPaise + allocation.creditPaise, 0),
  }
}
