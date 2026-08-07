import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = join(root, 'output', 'pdf')
const fontBytes = await readFile(join(root, 'src', 'assets', 'NotoSansGujarati-Regular.ttf'))
const logoBytes = await readFile(join(root, 'public', 'logo.png'))
const nativeFetch = globalThis.fetch

globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('NotoSansGujarati')) return new Response(fontBytes)
  if (url.endsWith('/logo.png') || url === '/logo.png') {
    return new Response(logoBytes, { headers: { 'content-type': 'image/png' } })
  }
  return nativeFetch(input, init)
}

const server = await createServer({ root, appType: 'custom', logLevel: 'error', server: { middlewareMode: true } })

try {
  const { invoicePdfBytes, receiptPdfBytes } = await server.ssrLoadModule('/src/lib/documents.ts')
  const settings = {
    businessName: 'Sitaram Cable & Broadband',
    address: '5-A Chamunda Society, Press Quater, Chitra, Bhavnagar -364004',
    phoneNumbers: '9825039825',
    upiId: '9825039825@ybl',
    logoUrl: '/logo.png',
  }
  const invoice = {
    id: 752,
    invoiceCode: 'SCN-IN-752',
    customerId: 42,
    customerCode: 'CUST-042',
    customerName: 'Ajay Bhai Rathod',
    phone: '9825039825',
    serviceType: 'cable',
    areaName: 'Chitra Area, Near Hanuman Temple',
    planName: 'FTA Cable Plan',
    stbNumber: 'STB752001',
    periodStart: '2026-07-26',
    periodEnd: '2026-08-24',
    issuedDate: '2026-07-26',
    dueDate: '2026-07-31',
    monthsBilled: 1,
    currentPeriodAmountPaise: 20000,
    previousDueSnapshotPaise: 5000,
    totalPayablePaise: 25000,
    chargeAmountPaise: 25000,
    balancePaise: 15000,
    liveBalancePaise: 15000,
    currentCustomerDuePaise: 15000,
    status: 'partial',
    billingMode: 'normal',
    historicalReason: null,
    isMerged: 0,
    isCombined: 0,
    charges: [
      { chargeType: 'opening_due', description: 'Previous outstanding', amountPaise: 5000 },
      { chargeType: 'service', description: 'FTA Cable Plan service charge', amountPaise: 20000 },
    ],
    allocations: [
      { paymentCode: 'PAY-612', paymentDate: '2026-07-27', periodStart: '2026-07-26', periodEnd: '2026-08-24', chargeType: 'opening_due', cashPaise: 5000, discountPaise: 0, creditPaise: 0 },
      { paymentCode: 'PAY-612', paymentDate: '2026-07-27', periodStart: '2026-07-26', periodEnd: '2026-08-24', chargeType: 'service', cashPaise: 5000, discountPaise: 0, creditPaise: 0 },
    ],
    mergeItems: [],
  }
  const receipt = {
    id: 612,
    paymentCode: 'PAY-612',
    customerId: 42,
    customerCode: 'CUST-042',
    customerName: 'Ajay Bhai Rathod',
    phone: '9825039825',
    serviceType: 'cable',
    stbNumber: 'STB752001',
    areaName: 'Chitra Area, Near Hanuman Temple',
    paymentDate: '2026-07-27',
    amountReceivedPaise: 10000,
    discountGivenPaise: 0,
    settledAmountPaise: 10000,
    paymentMode: 'upi',
    paymentReference: 'UTR-726194835102',
    resultingStatus: 'partial',
    liveBalancePaise: 15000,
    notes: 'Payment checked and recorded by admin.',
    allocations: [
      { invoiceCode: 'SCN-IN-752', periodStart: '2026-07-26', periodEnd: '2026-08-24', chargeType: 'opening_due', cashPaise: 5000, discountPaise: 0, creditPaise: 0 },
      { invoiceCode: 'SCN-IN-752', periodStart: '2026-07-26', periodEnd: '2026-08-24', chargeType: 'service', cashPaise: 5000, discountPaise: 0, creditPaise: 0 },
    ],
  }

  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(outputDirectory, 'sitaram-invoice-sample.pdf'), await invoicePdfBytes(invoice, settings, 'Shaktisinh')),
    writeFile(join(outputDirectory, 'sitaram-payment-receipt-sample.pdf'), await receiptPdfBytes(receipt, settings, 'Shaktisinh')),
  ])
  process.stdout.write(`${outputDirectory}\n`)
} finally {
  await server.close()
  globalThis.fetch = nativeFetch
}
