function cell(value: unknown) {
  const text = String(value ?? '')
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

export function downloadCsv(filename: string, records: Array<Record<string, unknown>>): void
export function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void
export function downloadCsv(filename: string, headersOrRecords: string[] | Array<Record<string, unknown>>, suppliedRows?: unknown[][]) {
  const objectRows = suppliedRows ? undefined : headersOrRecords as Array<Record<string, unknown>>
  const headers = suppliedRows ? headersOrRecords as string[] : Object.keys(objectRows?.[0] ?? {})
  const rows = suppliedRows ?? (objectRows ?? []).map((record) => headers.map((header) => record[header]))
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
