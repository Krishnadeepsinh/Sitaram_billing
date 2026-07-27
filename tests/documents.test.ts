import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createPdfBytes, invoiceDisplayBreakdown, invoicePaymentUri, paymentDisplayBreakdown, receiptPdfBytes, shareInvoice, statementPdfBytes } from '../src/lib/documents'
import type { BusinessSettings, Customer, InvoiceDetail, Payment, PaymentDetail } from '../src/lib/api'

const settings: BusinessSettings = { businessName: 'Sitaram Billing', address: 'Bhavnagar', phoneNumbers: '9825039825', upiId: 'sitaram@ybl', logoUrl: null }
const invoice: InvoiceDetail = {
  id: 1, invoiceCode: 'INV-001', customerId: 1, serviceType: 'cable', customerCode: 'CUST-001', customerName: 'Test Customer', areaName: 'Bhavnagar', planName: 'FTA', stbNumber: 'STB-1',
  periodStart: '2026-07-19', periodEnd: '2026-08-17', issuedDate: '2026-07-19', monthsBilled: 1, currentPeriodAmountPaise: 20000,
  previousDueSnapshotPaise: 0, totalPayablePaise: 20000, chargeAmountPaise: 20000, dueDate: '2026-08-24', status: 'unpaid', billingMode: 'normal', historicalReason: null,
  liveBalancePaise: 20000, currentCustomerDuePaise: 20000, charges: [{ chargeType: 'service', description: 'FTA service charge', amountPaise: 20000 }], allocations: [], mergeItems: [],
}

describe('PDF generation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('embeds Gujarati customer text without corrupting the PDF', async () => {
    const documentFont = await readFile(new URL('../src/assets/NotoSansGujarati-Regular.ttf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('NotoSansGujarati')) return new Response(documentFont)
      return new Response(null, { status: 404 })
    }))
    const bytes = await createPdfBytes('SERVICE INVOICE', 'INV-001', [
      { label: 'Customer', value: 'અગરસંગભાઈ પરમાર' },
      { label: 'Area', value: 'ગુજરાત' },
    ], { businessName: 'Sitaram Billing', address: 'Gujarat', phoneNumbers: '9825039825', upiId: 'sitaram@ybl', logoUrl: null })
    expect(bytes.byteLength).toBeGreaterThan(3_000)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })

  it('wraps long values and creates valid continuation pages', async () => {
    const documentFont = await readFile(new URL('../src/assets/NotoSansGujarati-Regular.ttf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('NotoSansGujarati') ? new Response(documentFont) : new Response(null, { status: 404 })))
    const bytes = await createPdfBytes('BUSINESS REPORT', 'ALL', [
      { label: 'Notes', value: 'X'.repeat(500) },
      ...Array.from({ length: 100 }, (_, index) => ({ label: `PAY-${index + 1}`, value: '19-07-2026 | અગરસંગભાઈ પરમાર | Cash INR 350.00 | Discount INR 50.00' })),
    ], { businessName: 'સીતારામ Billing', address: 'ભાવનગર, Gujarat', phoneNumbers: '9825039825', upiId: 'sitaram@ybl', logoUrl: null })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1)
    const serialized = new TextDecoder('latin1').decode(bytes)
    expect(serialized).toMatch(/\/Helvetica-\d{1,4}\b/)
    expect(serialized).not.toMatch(/\/Helvetica-\d{8,}\b/)
  })

  it('creates a customer statement with invoices, payments, and references', async () => {
    const documentFont = await readFile(new URL('../src/assets/NotoSansGujarati-Regular.ttf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('NotoSansGujarati') ? new Response(documentFont) : new Response(null, { status: 404 })))
    const customer = {
      id: 1, sortOrder: 1, customerCode: 'CUST-001', name: 'Test Customer', phone: '9999999999', stbNumber: 'STB-1', status: 'active',
      nextBillingStartDate: '2026-08-18', installationDate: '2026-01-01', areaId: 1, planId: 1, areaName: 'Bhavnagar', planName: 'FTA', planPricePaise: 20000, planIsActive: 1,
      amountDuePaise: 20000, previousDuePaise: 0, currentPlanDuePaise: 20000, futurePlanDuePaise: 0, unbilledOpeningDuePaise: 0, creditBalancePaise: 0,
      openInvoiceCount: 1, oldestDuePeriodStart: '2026-07-19', latestDuePeriodEnd: '2026-08-17', latestPeriodStart: '2026-07-19', latestPeriodEnd: '2026-08-17',
      duePlanPeriodStart: '2026-07-19', duePlanCycleEndStart: '2026-07-19', coverageStatus: 'active', hasHistoricalGap: 0,
    } as Customer
    const payment = { id: 1, paymentCode: 'PAY-001', customerId: 1, customerName: 'Test Customer', paymentDate: '2026-07-20', amountReceivedPaise: 20000, discountGivenPaise: 0, settledAmountPaise: 20000, paymentMode: 'upi', paymentReference: 'UTR-123', resultingStatus: 'settled' } as Payment
    const bytes = await statementPdfBytes(customer, [invoice], [payment], settings)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('creates a valid receipt with payment reference, allocation, and live balance', async () => {
    const documentFont = await readFile(new URL('../src/assets/NotoSansGujarati-Regular.ttf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('NotoSansGujarati') ? new Response(documentFont) : new Response(null, { status: 404 })))
    const payment: PaymentDetail = {
      id: 1, paymentCode: 'PAY-001', customerId: 1, customerName: 'Test Customer', customerCode: 'CUST-001', phone: '9999999999', stbNumber: 'STB-1', areaName: 'Long Customer Area Near Main Road', serviceType: 'cable',
      paymentDate: '2026-07-20', amountReceivedPaise: 15000, discountGivenPaise: 5000, settledAmountPaise: 20000, paymentMode: 'upi', paymentReference: 'UTR-123456789', resultingStatus: 'settled', liveBalancePaise: 0, notes: 'Checked and recorded by administrator.',
      allocations: [{ invoiceCode: 'INV-001', periodStart: '2026-07-19', periodEnd: '2026-08-17', chargeType: 'service', cashPaise: 15000, discountPaise: 5000, creditPaise: 0 }],
    }
    const bytes = await receiptPdfBytes(payment, settings)
    expect(bytes.byteLength).toBeGreaterThan(4_000)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })

  it('prefills the exact balance and invoice reference in the UPI QR payload', () => {
    const uri = invoicePaymentUri(invoice, settings)
    expect(uri).not.toBeNull()
    const parsed = new URL(uri!)
    expect(parsed.searchParams.get('pa')).toBe('sitaram@ybl')
    expect(parsed.searchParams.get('am')).toBe('200.00')
    expect(parsed.searchParams.get('tn')).toBe('Invoice INV-001')
    expect(parsed.searchParams.get('tr')).toBe('INV-001')
    expect(invoicePaymentUri({ ...invoice, liveBalancePaise: 0 }, settings)).toBeNull()
  })

  it('shows payments and discounts separately from the amount left to pay', () => {
    const partialInvoice: InvoiceDetail = {
      ...invoice,
      currentPeriodAmountPaise: 20000,
      previousDueSnapshotPaise: 5000,
      totalPayablePaise: 25000,
      liveBalancePaise: 15000,
      status: 'partial',
      allocations: [{ paymentCode: 'PAY-100', paymentDate: '2026-07-20', periodStart: invoice.periodStart, periodEnd: invoice.periodEnd, cashPaise: 10000, discountPaise: 0, creditPaise: 0 }],
    }
    expect(invoiceDisplayBreakdown(partialInvoice)).toEqual({
      monthlyServicePaise: 20000,
      oldUnpaidPaise: 5000,
      totalBillPaise: 25000,
      paymentReceivedPaise: 10000,
      discountGivenPaise: 0,
      customerCreditUsedPaise: 0,
      amountLeftPaise: 15000,
    })
  })

  it('keeps receipt payment, discount, covered amount, and unpaid amount distinct', () => {
    const payment = {
      amountReceivedPaise: 10000,
      discountGivenPaise: 2000,
      settledAmountPaise: 12000,
      liveBalancePaise: 13000,
      allocations: [{ invoiceCode: 'INV-001', periodStart: invoice.periodStart, periodEnd: invoice.periodEnd, cashPaise: 10000, discountPaise: 2000, creditPaise: 0 }],
    } as PaymentDetail
    expect(paymentDisplayBreakdown(payment)).toEqual({
      paymentReceivedPaise: 10000,
      discountGivenPaise: 2000,
      customerCreditUsedPaise: 0,
      totalBillCoveredPaise: 12000,
      amountStillUnpaidPaise: 13000,
    })
  })

  it('uses the native file share path when supported', async () => {
    const documentFont = await readFile(new URL('../src/assets/NotoSansGujarati-Regular.ttf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('NotoSansGujarati') ? new Response(documentFont) : new Response(null, { status: 404 })))
    const share = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { canShare: () => true, share })
    await shareInvoice(invoice, settings)
    expect(share).toHaveBeenCalledOnce()
    const payload = share.mock.calls[0][0] as { title: string; files: File[] }
    expect(payload.title).toContain('INV-001')
    expect(payload.files[0]).toMatchObject({ name: 'INV-001.pdf', type: 'application/pdf' })
  })

  it('downloads the PDF and opens an honest WhatsApp attach prompt when native sharing is unavailable', async () => {
    vi.useFakeTimers()
    const documentFont = await readFile(new URL('../src/assets/NotoSansGujarati-Regular.ttf', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('NotoSansGujarati') ? new Response(documentFont) : new Response(null, { status: 404 })))
    vi.stubGlobal('navigator', {})
    const click = vi.fn(); const open = vi.fn(); const revoke = vi.fn()
    vi.stubGlobal('document', { createElement: () => ({ click }) })
    vi.stubGlobal('window', { open })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-invoice')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke)
    await shareInvoice(invoice, settings)
    expect(click).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(expect.stringContaining('Please%20attach%20INV-001.pdf'), '_blank', 'noopener,noreferrer')
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith('blob:test-invoice')
    vi.useRealTimers()
  })
})
