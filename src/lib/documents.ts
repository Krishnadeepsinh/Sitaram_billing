import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import gujaratiFontUrl from '@fontsource/noto-sans-gujarati/files/noto-sans-gujarati-gujarati-400-normal.woff?url'
import type { BusinessSettings, InvoiceDetail, PaymentDetail, Report } from './api'

type Row = { label: string; value: string }
const pdfMoney = (paise: number) => `INR ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function createPdf(title: string, code: string, rows: Row[], settings: BusinessSettings) {
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit)
  const regular = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const gujarati = await pdf.embedFont(await fetch(gujaratiFontUrl).then((response) => response.arrayBuffer()))
  let page = pdf.addPage([595, 842]); let y = 730
  const header = () => {
    page.drawRectangle({ x: 0, y: 760, width: 595, height: 82, color: rgb(0.06, 0.16, 0.26) })
    page.drawText(settings.businessName || 'Sitaram Billing', { x: 40, y: 804, size: 19, font: bold, color: rgb(1, 1, 1) })
    page.drawText(title, { x: 40, y: 782, size: 11, font: regular, color: rgb(.86, .91, .96) })
    page.drawText(code, { x: 390, y: 798, size: 11, font: bold, color: rgb(1, .75, .35) })
    page.drawRectangle({ x: 518, y: 779, width: 37, height: 37, borderWidth: 1, borderColor: rgb(.62, .72, .82) })
    page.drawText('LOGO', { x: 524, y: 794, size: 7, font: bold, color: rgb(.72, .8, .87) })
  }
  const addPage = () => { page = pdf.addPage([595, 842]); y = 770 }
  header()
  for (const row of rows) {
    if (y < 70) addPage()
    page.drawText(row.label, { x: 40, y, size: 9, font: bold, color: rgb(.38, .46, .56) })
    drawMixedText(page, row.value || '—', 190, y, 10.5, regular, gujarati)
    page.drawLine({ start: { x: 40, y: y - 9 }, end: { x: 555, y: y - 9 }, thickness: .5, color: rgb(.89, .91, .94) })
    y -= 27
  }
  const footer = [settings.address, settings.phoneNumbers, settings.upiId ? `UPI: ${settings.upiId}` : ''].filter(Boolean).join('  |  ')
  for (const pdfPage of pdf.getPages()) pdfPage.drawText(footer.slice(0, 110), { x: 40, y: 28, size: 8, font: regular, color: rgb(.38, .46, .56) })
  return pdf.save()
}

function drawMixedText(page: ReturnType<PDFDocument['addPage']>, value: string, x: number, y: number, size: number, latin: Awaited<ReturnType<PDFDocument['embedFont']>>, gujarati: Awaited<ReturnType<PDFDocument['embedFont']>>) {
  const runs = value.match(/[\u0A80-\u0AFF]+|[^\u0A80-\u0AFF]+/g) ?? [value]
  let cursor = x
  for (const run of runs) { const font = /[\u0A80-\u0AFF]/.test(run) ? gujarati : latin; page.drawText(run, { x: cursor, y, size, font, color: rgb(.08, .13, .2) }); cursor += font.widthOfTextAtSize(run, size) }
}

function saveBytes(fileName: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }))
  Object.assign(document.createElement('a'), { href: url, download: fileName }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function shareOrDownload(fileName: string, title: string, bytes: Uint8Array) {
  const file = new File([bytes as unknown as BlobPart], fileName, { type: 'application/pdf' })
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) return navigator.share({ title, files: [file] })
  saveBytes(fileName, bytes)
  window.open(`https://wa.me/?text=${encodeURIComponent(`${title} downloaded. Please attach ${fileName}.`)}`, '_blank', 'noopener,noreferrer')
}

function invoiceRows(invoice: InvoiceDetail): Row[] {
  return [
    { label: 'Billing date', value: invoice.issuedDate }, { label: 'Due date', value: invoice.dueDate },
    { label: 'Customer', value: invoice.customerName }, { label: 'Customer / STB ID', value: `${invoice.customerCode}${invoice.stbNumber ? ` / ${invoice.stbNumber}` : ''}` },
    { label: 'Area', value: invoice.areaName }, { label: 'Plan', value: invoice.planName }, { label: 'Service period', value: `${invoice.periodStart} to ${invoice.periodEnd}` },
    ...invoice.mergeItems.map((item) => ({ label: `Merged ${item.invoiceCode}`, value: `${item.planName} | ${item.periodStart} to ${item.periodEnd} | ${pdfMoney(item.amountPaise)}` })),
    { label: 'Previous due at issue', value: pdfMoney(invoice.previousDueSnapshotPaise) }, { label: 'Current period amount', value: pdfMoney(invoice.currentPeriodAmountPaise) },
    { label: 'Total payable at issue', value: pdfMoney(invoice.totalPayablePaise) }, { label: 'Live invoice balance', value: pdfMoney(invoice.liveBalancePaise) },
    ...invoice.allocations.map((item) => ({ label: `Payment ${item.paymentCode}`, value: `${item.paymentDate} | Cash ${pdfMoney(item.cashPaise)} | Discount ${pdfMoney(item.discountPaise)} | Credit ${pdfMoney(item.creditPaise)}` })),
    { label: 'Status', value: invoice.status.toUpperCase() },
  ]
}

function receiptRows(payment: PaymentDetail): Row[] {
  return [
    { label: 'Payment date', value: payment.paymentDate }, { label: 'Customer', value: payment.customerName }, { label: 'Customer / STB ID', value: `${payment.customerCode}${payment.stbNumber ? ` / ${payment.stbNumber}` : ''}` },
    { label: 'Area', value: payment.areaName }, { label: 'Payment mode', value: payment.paymentMode.replace('_', ' ').toUpperCase() }, { label: 'Amount received', value: pdfMoney(payment.amountReceivedPaise) },
    { label: 'Discount given', value: pdfMoney(payment.discountGivenPaise) }, { label: 'Notes', value: payment.notes || '—' },
    ...payment.allocations.map((item) => ({ label: `Allocated to ${item.invoiceCode}`, value: `${item.periodStart} to ${item.periodEnd} | Cash ${pdfMoney(item.cashPaise)} | Discount ${pdfMoney(item.discountPaise)} | Credit ${pdfMoney(item.creditPaise)}` })),
    { label: 'Final status', value: payment.resultingStatus.replace('_', ' ').toUpperCase() },
  ]
}

export async function downloadInvoice(invoice: InvoiceDetail, settings: BusinessSettings) { saveBytes(`${invoice.invoiceCode}.pdf`, await createPdf('SERVICE INVOICE', invoice.invoiceCode, invoiceRows(invoice), settings)) }
export async function shareInvoice(invoice: InvoiceDetail, settings: BusinessSettings) { await shareOrDownload(`${invoice.invoiceCode}.pdf`, `${settings.businessName} invoice ${invoice.invoiceCode}`, await createPdf('SERVICE INVOICE', invoice.invoiceCode, invoiceRows(invoice), settings)) }
export async function downloadReceipt(payment: PaymentDetail, settings: BusinessSettings) { saveBytes(`${payment.paymentCode}.pdf`, await createPdf('PAYMENT RECEIPT', payment.paymentCode, receiptRows(payment), settings)) }
export async function shareReceipt(payment: PaymentDetail, settings: BusinessSettings) { await shareOrDownload(`${payment.paymentCode}.pdf`, `${settings.businessName} receipt ${payment.paymentCode}`, await createPdf('PAYMENT RECEIPT', payment.paymentCode, receiptRows(payment), settings)) }

export async function downloadReportPdf(report: Report, settings: BusinessSettings) {
  const rows: Row[] = [{ label: 'Report period', value: `${report.from} to ${report.to}` }, { label: 'Scope', value: report.scope.toUpperCase() }, { label: 'Billed', value: pdfMoney(report.billedPaise) }, { label: 'Collected', value: pdfMoney(report.collectedPaise) }, { label: 'Outstanding', value: pdfMoney(report.outstandingPaise) }, { label: report.netLabel, value: pdfMoney(report.netPaise) }, ...report.payments.map((payment) => ({ label: payment.paymentCode, value: `${payment.paymentDate} | ${payment.customerName} | ${pdfMoney(payment.amountReceivedPaise)} | ${payment.paymentMode}` })), ...report.expenses.map((expense) => ({ label: `Expense ${expense.category}`, value: `${expense.expenseDate} | ${expense.description} | ${pdfMoney(expense.amountPaise)}` }))]
  saveBytes(`sitaram-report-${report.from}-${report.to}.pdf`, await createPdf('BUSINESS REPORT', report.scope.toUpperCase(), rows, settings))
}

export function downloadReportExcel(report: Report) {
  const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows = [['Type', 'Code / Category', 'Name / Description', 'Date', 'Mode', 'Amount'], ...report.payments.map((p) => ['Collection', p.paymentCode, p.customerName, p.paymentDate, p.paymentMode, (p.amountReceivedPaise / 100).toFixed(2)]), ...report.expenses.map((e) => ['Expense', e.category, e.description, e.expenseDate, '', (e.amountPaise / 100).toFixed(2)])]
  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Report"><Table>${rows.map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="String">${escape(cell)}</Data></Cell>`).join('')}</Row>`).join('')}</Table></Worksheet></Workbook>`
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.ms-excel' })); Object.assign(document.createElement('a'), { href: url, download: `sitaram-report-${report.from}-${report.to}.xls` }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
