import { allocateOldestFirst } from './billing'

export type ReplayInvoice = { id: number; periodStart: string; amountPaise: number; createdAt?: string }
export type ReplayPayment = { id: number; amountReceivedPaise: number; discountGivenPaise: number; paymentMode: 'cash' | 'upi' | 'system_credit'; createdAt?: string }

export function replayLedger(openingCreditPaise: number, invoices: ReplayInvoice[], payments: ReplayPayment[]) {
  const allocated = new Map(invoices.map((invoice) => [invoice.id, 0]))
  const allocations: Array<{ paymentId: number; invoiceId: number; cashPaise: number; discountPaise: number; creditPaise: number }> = []
  const paymentStatuses: Array<{ paymentId: number; status: 'partial' | 'settled' | 'credit_added' }> = []
  let creditPaise = openingCreditPaise

  for (const payment of payments) {
    // A past collection must never be replayed as cash against an invoice that
    // did not exist when that collection was recorded. Any remainder first
    // becomes credit and is later consumed by the next payment/system-credit event.
    const balances = invoices
      .filter((invoice) => !payment.createdAt || !invoice.createdAt || invoice.createdAt <= payment.createdAt)
      .map((invoice) => ({ id: invoice.id, periodStart: invoice.periodStart, currentAmountPaise: invoice.amountPaise, allocatedPaise: allocated.get(invoice.id) ?? 0 }))
    const result = allocateOldestFirst(
      balances,
      payment.paymentMode === 'system_credit' ? 0 : payment.amountReceivedPaise,
      payment.paymentMode === 'system_credit' ? 0 : payment.discountGivenPaise,
      creditPaise,
    )
    for (const item of result.allocations) {
      allocated.set(item.invoiceId, (allocated.get(item.invoiceId) ?? 0) + item.cashPaise + item.discountPaise + item.creditPaise)
      allocations.push({ paymentId: payment.id, ...item })
    }
    creditPaise = result.remainingCreditPaise
    paymentStatuses.push({ paymentId: payment.id, status: result.remainingBalancePaise > 0 ? 'partial' : creditPaise > 0 ? 'credit_added' : 'settled' })
  }

  return {
    allocations,
    paymentStatuses,
    invoiceStatuses: invoices.map((invoice) => {
      const settled = allocated.get(invoice.id) ?? 0
      return { invoiceId: invoice.id, status: settled >= invoice.amountPaise ? 'paid' as const : settled > 0 ? 'partial' as const : 'unpaid' as const }
    }),
    creditPaise,
  }
}
