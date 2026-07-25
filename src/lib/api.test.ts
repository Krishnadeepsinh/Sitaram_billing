import { afterEach, describe, expect, it, vi } from 'vitest'
import { listAllInvoices, listAllPayments } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('complete exports', () => {
  it.each([
    ['invoices', () => listAllInvoices('cable')],
    ['payments', () => listAllPayments('cable')],
  ])('loads every filtered %s page', async (_name, load) => {
    const offsets: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://localhost')
      const offset = Number(url.searchParams.get('offset') ?? 0)
      offsets.push(offset)
      const total = 250
      const limit = 200
      return new Response(JSON.stringify({ items: Array.from({ length: Math.min(limit, total - offset) }, (_, index) => ({ id: offset + index + 1 })), total, limit, offset }))
    }))

    expect(await load()).toHaveLength(250)
    expect(offsets).toEqual([0, 200])
  })
})
