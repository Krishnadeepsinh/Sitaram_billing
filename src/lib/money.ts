const MONEY_PATTERN = /^\d+(?:\.\d{1,2})?$/

export function rupeesToPaise(value: string): number {
  const normalized = value.trim()
  if (!MONEY_PATTERN.test(normalized)) throw new Error('Enter a non-negative amount with at most two decimal places.')
  const [rupees, decimal = ''] = normalized.split('.')
  return Number(rupees) * 100 + Number(decimal.padEnd(2, '0'))
}

export function formatRupees(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100)
}

function moneyPreviewPaise(value: string): number {
  const normalized = value.trim()
  return /^\d+(?:\.\d{0,2})?$/.test(normalized)
    ? Math.round(Number(normalized) * 100)
    : 0
}

export function paymentEntryBreakdown(
  duePaise: number,
  amountValue: string,
  discountValue: string,
) {
  const safeDuePaise = Math.max(0, duePaise)
  const amountReceivedPaise = moneyPreviewPaise(amountValue)
  const discountGivenPaise = moneyPreviewPaise(discountValue)
  const maxDiscountPaise = Math.max(0, safeDuePaise - amountReceivedPaise)
  const appliedDiscountPaise = Math.min(discountGivenPaise, maxDiscountPaise)

  return {
    amountReceivedPaise,
    discountGivenPaise,
    maxDiscountPaise,
    discountExcessPaise: Math.max(0, discountGivenPaise - maxDiscountPaise),
    coveredPaise: Math.min(
      safeDuePaise,
      amountReceivedPaise + appliedDiscountPaise,
    ),
    remainingDuePaise: Math.max(
      0,
      safeDuePaise - amountReceivedPaise - appliedDiscountPaise,
    ),
    advanceCreditPaise: Math.max(0, amountReceivedPaise - safeDuePaise),
  }
}

export function paymentAmountAfterDiscount(duePaise: number, discountValue: string): string {
  const discountPaise = moneyPreviewPaise(discountValue)
  return (Math.max(0, duePaise - discountPaise) / 100).toFixed(2)
}
