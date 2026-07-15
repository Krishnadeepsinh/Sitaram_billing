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
