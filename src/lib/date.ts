const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const SLASH_PATTERN = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/
const displayDate = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
const displayMonth = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })

export class DateInputError extends Error {}

function toIso(year: number, month: number, day: number): string {
  const value = new Date(Date.UTC(year, month - 1, day))
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new DateInputError('Enter a real calendar date.')
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function businessDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function parseStrictDate(input: string | number | Date): string {
  if (input instanceof Date) {
    if (Number.isNaN(input.valueOf())) throw new DateInputError('Invalid date.')
    return businessDate(input)
  }
  if (typeof input === 'number') {
    const milliseconds = Math.abs(input) < 100_000_000_000 ? input * 1000 : input
    return parseStrictDate(new Date(milliseconds))
  }
  const iso = ISO_PATTERN.exec(input)
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const slash = SLASH_PATTERN.exec(input)
  if (!slash) throw new DateInputError('Use DD/MM/YYYY or YYYY-MM-DD.')
  const year = slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3])
  return toIso(year, Number(slash[2]), Number(slash[1]))
}

export function addBillingDays(isoDate: string, days: number): string {
  const [year, month, day] = parseStrictDate(isoDate).split('-').map(Number)
  const result = new Date(Date.UTC(year, month - 1, day + days))
  return result.toISOString().slice(0, 10)
}

export function todayInBusinessTimezone(): string {
  return businessDate(new Date())
}

export function endOfCalendarMonth(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new DateInputError('Choose a valid month.')
  const [year, monthNumber] = month.split('-').map(Number)
  if (monthNumber < 1 || monthNumber > 12) throw new DateInputError('Choose a valid month.')
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
}

export function formatBusinessDate(value: string): string {
  return displayDate.format(new Date(`${parseStrictDate(value)}T00:00:00Z`))
}

export function formatBusinessMonth(value: string): string {
  return displayMonth.format(new Date(`${parseStrictDate(value)}T00:00:00Z`))
}

export function billingCyclePosition(periodStart: string, periodEnd: string, today = todayInBusinessTimezone()): 'Previous cycle' | 'Current cycle' | 'Next / future cycle' {
  if (parseStrictDate(periodEnd) < today) return 'Previous cycle'
  if (parseStrictDate(periodStart) <= today) return 'Current cycle'
  return 'Next / future cycle'
}
