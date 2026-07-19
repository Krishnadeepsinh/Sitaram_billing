import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createPdfBytes } from '../src/lib/documents'

describe('PDF generation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('embeds Gujarati customer text without corrupting the PDF', async () => {
    const font = await readFile(new URL('../src/assets/NotoSansGujarati-variable.ttf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('NotoSansGujarati')) return new Response(font)
      return new Response(null, { status: 404 })
    }))
    const bytes = await createPdfBytes('SERVICE INVOICE', 'INV-001', [
      { label: 'Customer', value: 'અગરસંગભાઈ પરમાર' },
      { label: 'Area', value: 'ગુજરાત' },
    ], { businessName: 'Sitaram Billing', address: 'Gujarat', phoneNumbers: '9825039825', upiId: 'sitaram@ybl', logoUrl: null })
    expect(bytes.byteLength).toBeGreaterThan(100_000)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })
})
