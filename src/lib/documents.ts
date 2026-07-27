import 'regenerator-runtime/runtime.js'
import fontkit, { type Font } from '@pdf-lib/fontkit'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import QRCode from 'qrcode'
import numberToWords from 'number-to-words'
import gujaratiFontUrl from '../assets/NotoSansGujarati-Regular.ttf?url'
import type { BusinessSettings, Customer, Invoice, InvoiceDetail, Payment, PaymentDetail, Report } from './api'
import { formatBusinessDate } from './date'

type Row = { label: string; value: string }
type EmbeddedFont = Awaited<ReturnType<PDFDocument['embedFont']>>
const pdfMoney = (paise: number) => `INR ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export async function createPdfBytes(title: string, code: string, rows: Row[], settings: BusinessSettings) {
  const pdf = await PDFDocument.create()
  let resourceId = 0
  pdf.context.addRandomSuffix = (prefix: string) => `${prefix}-${++resourceId}`
  const gujaratiBytes = await fetch(gujaratiFontUrl).then((response) => response.arrayBuffer())
  const regular = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const gujarati = fontkit.create(new Uint8Array(gujaratiBytes))
  const logo = await embedLogo(pdf, settings.logoUrl || '/logo.png')
  type PdfPage = ReturnType<PDFDocument['addPage']>
  let page!: PdfPage; let y = 718; let rowIndex = 0
  const navy = rgb(0.06, 0.16, 0.26); const muted = rgb(.38, .46, .56); const line = rgb(.87, .9, .94); const accent = rgb(.96, .45, .08)
  const header = (target: PdfPage, targetGujarati: Font) => {
    target.drawRectangle({ x: 0, y: 748, width: 595, height: 94, color: navy })
    target.drawText(title, { x: 40, y: 775, size: 10, font: bold, color: rgb(.72, .83, .92) })
    target.drawText(code, { x: 390, y: 798, size: 11, font: bold, color: rgb(1, .75, .35) })
    if (logo) target.drawImage(logo, { x: 516, y: 775, width: 40, height: 40 })
    else {
      target.drawRectangle({ x: 518, y: 776, width: 37, height: 37, borderWidth: 1, borderColor: rgb(.62, .72, .82) })
      target.drawText('LOGO', { x: 524, y: 794, size: 7, font: bold, color: rgb(.72, .8, .87) })
    }
    const businessName = settings.businessName || 'Sitaram Billing'
    if (/[\u0A80-\u0AFF]/.test(businessName)) drawMixedText(target, truncateText(businessName, 330, 19, bold, targetGujarati), 40, 804, 19, bold, targetGujarati, rgb(1, 1, 1))
    else target.drawText(truncateText(businessName, 330, 19, bold, targetGujarati), { x: 40, y: 809, size: 19, font: bold, color: rgb(1, 1, 1) })
    const contact = [settings.address, settings.phoneNumbers].filter(Boolean).join('  |  ')
    if (contact) drawMixedText(target, truncateText(contact, 440, 8, regular, targetGujarati), 40, 758, 8, regular, targetGujarati, rgb(.72, .83, .92))
  }
  const addPage = async () => {
    page = pdf.addPage([595, 842]); y = 718; rowIndex = 0
    header(page, gujarati)
    page.drawText(title === 'PAYMENT RECEIPT' ? 'PAYMENT DETAILS' : 'BILLING DETAILS', { x: 40, y, size: 9, font: bold, color: accent })
    y -= 22
  }
  await addPage()
  for (const row of rows) {
    const lines = wrapText(row.value || '—', 365, 10.5, regular, gujarati)
    const rowHeight = Math.max(30, 17 + lines.length * 13)
    if (y - rowHeight < 55) await addPage()
    const isTotal = /total payable|amount received|live invoice balance|final status/i.test(row.label)
    if (isTotal) page.drawRectangle({ x: 40, y: y - rowHeight + 5, width: 515, height: rowHeight - 2, color: /status/i.test(row.label) ? rgb(.95, .97, .99) : rgb(1, .96, .9) })
    else if (rowIndex % 2 === 0) page.drawRectangle({ x: 40, y: y - rowHeight + 5, width: 515, height: rowHeight - 2, color: rgb(.98, .99, 1) })
    drawMixedText(page, row.label, 52, y, 8.5, bold, gujarati, muted)
    lines.forEach((line, index) => drawMixedText(page, line, 190, y - index * 13, isTotal ? 11.5 : 10.5, isTotal ? bold : regular, gujarati, isTotal && !/status/i.test(row.label) ? accent : rgb(.08, .13, .2)))
    page.drawLine({ start: { x: 40, y: y - rowHeight + 5 }, end: { x: 555, y: y - rowHeight + 5 }, thickness: .45, color: line })
    y -= rowHeight; rowIndex += 1
  }
  const footer = [settings.address, settings.phoneNumbers, settings.upiId ? `UPI: ${settings.upiId}` : ''].filter(Boolean).join('  |  ')
  const pages = pdf.getPages()
  pages.forEach((pdfPage, index) => {
    drawMixedText(pdfPage, truncateText(footer, 430, 8, regular, gujarati), 40, 28, 8, regular, gujarati, rgb(.38, .46, .56))
    pdfPage.drawText(`Page ${index + 1} of ${pages.length}`, { x: 500, y: 28, size: 8, font: regular, color: rgb(.38, .46, .56) })
  })
  // Classic cross-reference tables are larger than object streams, but render
  // reliably in older/mobile PDF readers used for shared WhatsApp documents.
  return pdf.save({ useObjectStreams: false })
}

async function embedLogo(pdf: PDFDocument, url: string) {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    const bytes = await response.arrayBuffer()
    return await (response.headers.get('content-type')?.includes('jpeg') || /\.jpe?g(?:\?|$)/i.test(url) ? pdf.embedJpg(bytes) : pdf.embedPng(bytes))
  } catch { return undefined }
}

function gujaratiTextWidth(value: string, size: number, font: Font) {
  return font.layout(value).positions.reduce((width, position) => width + position.xAdvance, 0) * size / font.unitsPerEm
}

function mixedTextWidth(value: string, size: number, latin: EmbeddedFont, gujarati: Font) {
  return (value.match(/[\u0A80-\u0AFF]+|[^\u0A80-\u0AFF]+/g) ?? [value]).reduce((width, run) => width + (/\p{Script=Gujarati}/u.test(run) ? gujaratiTextWidth(run, size, gujarati) : latin.widthOfTextAtSize(run, size)), 0)
}

function truncateText(value: string, maxWidth: number, size: number, latin: EmbeddedFont, gujarati: Font) {
  if (mixedTextWidth(value, size, latin, gujarati) <= maxWidth) return value
  let result = ''
  for (const character of value) {
    if (mixedTextWidth(`${result}${character}...`, size, latin, gujarati) > maxWidth) break
    result += character
  }
  return `${result}...`
}

function wrapText(value: string, maxWidth: number, size: number, latin: EmbeddedFont, gujarati: Font) {
  const words = value.split(/\s+/); const lines: string[] = []; let line = ''
  for (const word of words) {
    if (mixedTextWidth(word, size, latin, gujarati) > maxWidth) {
      if (line) { lines.push(line); line = '' }
      let chunk = ''
      for (const character of word) {
        if (chunk && mixedTextWidth(chunk + character, size, latin, gujarati) > maxWidth) { lines.push(chunk); chunk = character }
        else chunk += character
      }
      line = chunk
      continue
    }
    const candidate = line ? `${line} ${word}` : word
    if (mixedTextWidth(candidate, size, latin, gujarati) <= maxWidth) line = candidate
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['—']
}

function drawMixedText(page: ReturnType<PDFDocument['addPage']>, value: string, x: number, y: number, size: number, latin: EmbeddedFont, gujarati: Font, color = rgb(.08, .13, .2)) {
  const runs = value.match(/[\u0A80-\u0AFF]+|[^\u0A80-\u0AFF]+/g) ?? [value]
  let cursor = x
  for (const run of runs) {
    if (!/[\u0A80-\u0AFF]/.test(run)) {
      const safeRun = Array.from(run.replace(/\u2713/g, 'V'), (character) => character.charCodeAt(0) <= 127 ? character : '-').join('')
      page.drawText(safeRun, { x: cursor, y, size, font: latin, color }); cursor += latin.widthOfTextAtSize(safeRun, size)
      continue
    }
    const scale = size / gujarati.unitsPerEm
    const layout = gujarati.layout(run)
    layout.glyphs.forEach((glyph, index) => {
      const position = layout.positions[index]
      page.drawSvgPath(fontPathForPdf(glyph.path), { x: cursor + position.xOffset * scale, y: y + position.yOffset * scale, scale, color })
      cursor += position.xAdvance * scale
    })
  }
}

function fontPathForPdf(path: unknown) {
  const commands = (path as { commands?: Array<{ command: string; args: number[] }> }).commands ?? []
  return commands.map(({ command, args }) => {
    if (command === 'moveTo') return `M ${args[0]} ${-args[1]}`
    if (command === 'lineTo') return `L ${args[0]} ${-args[1]}`
    if (command === 'quadraticCurveTo') return `Q ${args[0]} ${-args[1]} ${args[2]} ${-args[3]}`
    if (command === 'bezierCurveTo') return `C ${args[0]} ${-args[1]} ${args[2]} ${-args[3]} ${args[4]} ${-args[5]}`
    return command === 'closePath' ? 'Z' : ''
  }).join(' ')
}

function saveBytes(fileName: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }))
  Object.assign(document.createElement('a'), { href: url, download: fileName }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function shareOrDownload(fileName: string, title: string, bytes: Uint8Array) {
  const file = new File([bytes as unknown as BlobPart], fileName, { type: 'application/pdf' })
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try { await navigator.share({ title, files: [file] }) }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      throw cause
    }
    return
  }
  saveBytes(fileName, bytes)
  window.open(`https://wa.me/?text=${encodeURIComponent(`${title} downloaded. Please attach ${fileName}.`)}`, '_blank', 'noopener,noreferrer')
}

type StatementVariant = 'invoice' | 'receipt'
type StatementFonts = { regular: EmbeddedFont; bold: EmbeddedFont; gujarati: Font }
const statementDate = (value?: string) => { if (!value) return '—'; const [year, month, day] = value.split('-'); return `${day}/${month}/${year}` }
const wordsForMoney = (paise: number) => { const rupees = Math.floor(Math.abs(paise) / 100); const cents = Math.abs(paise) % 100; const phrase = `${numberToWords.toWords(rupees)}${cents ? ` rupees and ${numberToWords.toWords(cents)} paise` : ' rupees'} only`; return phrase.charAt(0).toUpperCase() + phrase.slice(1) }
const rupee = (paise: number) => `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
function decodeDataUrl(value: string) { const encoded = value.split(',')[1] ?? ''; const binary = atob(encoded); return Uint8Array.from(binary, (character) => character.charCodeAt(0)) }

export function invoicePaymentUri(invoice: Pick<InvoiceDetail, 'invoiceCode' | 'liveBalancePaise'>, settings: Pick<BusinessSettings, 'businessName' | 'upiId'>) {
  const balanceDue = Math.max(0, Number(invoice.liveBalancePaise || 0))
  if (!settings.upiId || balanceDue <= 0) return null
  const params = new URLSearchParams({
    pa: settings.upiId,
    pn: settings.businessName || 'Sitaram Cable',
    am: (balanceDue / 100).toFixed(2),
    cu: 'INR',
    tn: `Invoice ${invoice.invoiceCode}`,
    tr: invoice.invoiceCode,
  })
  return `upi://pay?${params}`
}

export function invoiceDisplayBreakdown(invoice: Pick<InvoiceDetail, 'currentPeriodAmountPaise' | 'previousDueSnapshotPaise' | 'totalPayablePaise' | 'liveBalancePaise' | 'allocations'>) {
  return {
    monthlyServicePaise: Number(invoice.currentPeriodAmountPaise || 0),
    oldUnpaidPaise: Number(invoice.previousDueSnapshotPaise || 0),
    totalBillPaise: Number(invoice.totalPayablePaise || 0),
    paymentReceivedPaise: invoice.allocations.reduce((total, item) => total + Number(item.cashPaise || 0), 0),
    discountGivenPaise: invoice.allocations.reduce((total, item) => total + Number(item.discountPaise || 0), 0),
    customerCreditUsedPaise: invoice.allocations.reduce((total, item) => total + Number(item.creditPaise || 0), 0),
    amountLeftPaise: Math.max(0, Number(invoice.liveBalancePaise || 0)),
  }
}

export function paymentDisplayBreakdown(payment: Pick<PaymentDetail, 'amountReceivedPaise' | 'discountGivenPaise' | 'settledAmountPaise' | 'liveBalancePaise' | 'allocations'>) {
  return {
    paymentReceivedPaise: Number(payment.amountReceivedPaise || 0),
    discountGivenPaise: Number(payment.discountGivenPaise || 0),
    customerCreditUsedPaise: payment.allocations.reduce((total, item) => total + Number(item.creditPaise || 0), 0),
    totalBillCoveredPaise: Number(payment.settledAmountPaise || 0),
    amountStillUnpaidPaise: Math.max(0, Number(payment.liveBalancePaise || 0)),
  }
}

function invoiceStatusLabel(status: string, amountLeftPaise: number) {
  if (amountLeftPaise <= 0) return 'PAID'
  if (status === 'partial') return 'PARTLY PAID'
  if (status === 'overdue') return 'PAYMENT OVERDUE'
  return 'PAYMENT DUE'
}

type StatementData = Record<string, any>
async function createStatementPdf(variant: StatementVariant, data: StatementData, settings: BusinessSettings) {
  const pdf = await PDFDocument.create(); const gujaratiBytes = await fetch(gujaratiFontUrl).then((response) => response.arrayBuffer())
  const fonts: StatementFonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold), gujarati: fontkit.create(new Uint8Array(gujaratiBytes)) }
  const navy = rgb(.03, .16, .38); const orange = rgb(.96, .3, .06); const green = rgb(.03, .47, .2); const red = rgb(.72, .12, .1)
  const ink = rgb(.08, .12, .19); const muted = rgb(.38, .43, .51); const line = rgb(.82, .85, .89); const soft = rgb(.97, .98, .99)
  const accent = variant === 'invoice' ? orange : green; const logo = await embedLogo(pdf, settings.logoUrl || '/logo.png')
  const serviceLabel = data.serviceType === 'broadband' ? 'Broadband Subscription' : 'Digital Cable TV'
  const generatedAt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date())
  const page = pdf.addPage([595, 842]); const draw = (value: string, x: number, y: number, size = 10, bold = false, color = ink) => drawMixedText(page, value, x, y, size, bold ? fonts.bold : fonts.regular, fonts.gujarati, color)
  const textWidth = (value: string, size: number, bold = false) => mixedTextWidth(value, size, bold ? fonts.bold : fonts.regular, fonts.gujarati)
  const right = 565
  if (logo) page.drawImage(logo, { x: 30, y: 762, width: 68, height: 68 })
  const businessName = truncateText(settings.businessName || 'Sitaram Cable & Broadband', 300, 16.5, fonts.bold, fonts.gujarati).toUpperCase()
  draw(businessName, 116, 810, 16.5, true, navy); draw('Connecting Every Home', 116, 791, 9, false, muted)
  draw(truncateText(`Phone: ${settings.phoneNumbers || '-'}   |   Address: ${settings.address || '-'}`, 305, 7.8, fonts.regular, fonts.gujarati), 116, 773, 7.8, false, ink)
  draw(truncateText(`WhatsApp: ${settings.phoneNumbers || '-'}   |   UPI: ${settings.upiId || '-'}`, 305, 7.8, fonts.regular, fonts.gujarati), 116, 757, 7.8, false, ink)
  const documentTitle = variant === 'invoice' ? 'INVOICE' : 'PAYMENT RECEIPT'
  draw(documentTitle, right - textWidth(documentTitle, variant === 'invoice' ? 18 : 14, true), 805, variant === 'invoice' ? 18 : 14, true, navy)
  if (variant === 'receipt') {
    const recorded = 'PAYMENT RECORDED'
    draw(recorded, right - textWidth(recorded, 8, true), 783, 8, true, green)
  }
  page.drawRectangle({ x: 30, y: 739, width: 535, height: 2.5, color: navy })
  page.drawRectangle({ x: 500, y: 739, width: 65, height: 2.5, color: accent })
  const info = variant === 'invoice'
    ? [['INVOICE NO', data.invoiceCode], ['BILLING DATE', statementDate(data.issuedDate)], ['DUE DATE', statementDate(data.dueDate)], ['STATUS', invoiceStatusLabel(data.status, Number(data.liveBalancePaise || 0))]]
    : [['RECEIPT NO', data.paymentCode], ['PAYMENT DATE', statementDate(data.paymentDate)], ['PAYMENT METHOD', String(data.paymentMode || '-').toUpperCase()], ['AMOUNT PAID', rupee(Number(data.amountReceivedPaise || 0))]]
  page.drawLine({ start: { x: 30, y: 681 }, end: { x: 565, y: 681 }, thickness: .65, color: line })
  info.forEach(([label, value], index) => {
    const width = 535 / 4; const x = 30 + index * width
    if (index) page.drawLine({ start: { x, y: 690 }, end: { x, y: 728 }, thickness: .5, color: line })
    draw(label, x + 10, 714, 7, true, muted)
    draw(truncateText(String(value || '-'), width - 20, index === 3 && variant === 'receipt' ? 11 : 9.5, fonts.bold, fonts.gujarati), x + 10, 694, index === 3 && variant === 'receipt' ? 11 : 9.5, true, index === 3 && variant === 'receipt' ? green : navy)
  })
  let y = variant === 'receipt' ? 645 : 653
  if (variant === 'receipt') draw(`Amount in words: ${wordsForMoney(Number(data.amountReceivedPaise || 0))}`, 30, 665, 7.5, false, muted)
  const drawSection = (x: number, width: number, top: number, title: string, fields: Array<[string, string]>) => {
    const prepared = fields.map(([label, value]) => ({ label, lines: wrapText(value || '-', width - 102, 8.5, fonts.bold, fonts.gujarati) }))
    draw(title, x, top, 9, true, navy)
    page.drawLine({ start: { x, y: top - 8 }, end: { x: x + width, y: top - 8 }, thickness: 1, color: navy })
    let rowY = top - 27
    prepared.forEach(({ label, lines }) => {
      const rowHeight = Math.max(23, 10 + lines.length * 11)
      draw(label, x, rowY, 7.8, false, muted)
      lines.forEach((value, lineIndex) => draw(value, x + 96, rowY - lineIndex * 11, 8.5, true, ink))
      page.drawLine({ start: { x, y: rowY - rowHeight + 8 }, end: { x: x + width, y: rowY - rowHeight + 8 }, thickness: .35, color: line })
      rowY -= rowHeight
    })
    return top - rowY
  }
  if (variant === 'invoice') {
    const invoice = data as InvoiceDetail
    const breakdown = invoiceDisplayBreakdown(invoice)
    const customerFields: Array<[string, string]> = [
      ['Full Name', invoice.customerName],
      ['Customer ID', invoice.customerCode],
      ...(invoice.stbNumber ? [['STB', invoice.stbNumber] as [string, string]] : []),
      ...(invoice.phone ? [['Mobile', invoice.phone] as [string, string]] : []),
    ]
    const serviceFields: Array<[string, string]> = [
      ['Service', serviceLabel],
      ['Plan', invoice.planName],
      ['Area', invoice.areaName],
      ['Period', `${statementDate(invoice.periodStart)} to ${statementDate(invoice.periodEnd)}`],
    ]
    const customerHeight = drawSection(30, 255, y, 'CUSTOMER', customerFields)
    const serviceHeight = drawSection(310, 255, y, 'SERVICE DETAILS', serviceFields)
    y -= Math.max(customerHeight, serviceHeight) + 18
    draw('BILL SUMMARY', 30, y, 9.5, true, navy)
    y -= 15
    page.drawRectangle({ x: 30, y: y - 23, width: 535, height: 23, color: soft, borderColor: line, borderWidth: .5 })
    draw('DESCRIPTION', 42, y - 15, 7.5, true, navy)
    const amountHeading = 'AMOUNT (Rs.)'
    draw(amountHeading, 553 - textWidth(amountHeading, 7.5, true), y - 15, 7.5, true, navy)
    y -= 23
    const billRows = [
      { label: 'Monthly Service', value: breakdown.monthlyServicePaise, color: ink, bold: false },
      { label: 'Old Unpaid Amount', value: breakdown.oldUnpaidPaise, color: ink, bold: false },
      { label: 'Total Bill', value: breakdown.totalBillPaise, color: navy, bold: true },
      { label: 'Payment Already Received', value: breakdown.paymentReceivedPaise, color: green, bold: true, subtract: true },
      { label: 'Discount Given', value: breakdown.discountGivenPaise, color: breakdown.discountGivenPaise > 0 ? orange : muted, bold: breakdown.discountGivenPaise > 0, subtract: true },
      ...(breakdown.customerCreditUsedPaise > 0 ? [{ label: 'Customer Credit Used', value: breakdown.customerCreditUsedPaise, color: navy, bold: false, subtract: true }] : []),
    ]
    billRows.forEach((row, index) => {
      if (index === 2) page.drawRectangle({ x: 30, y: y - 26, width: 535, height: 26, color: rgb(.95, .97, 1) })
      else if (index === 3) page.drawRectangle({ x: 30, y: y - 26, width: 535, height: 26, color: rgb(.94, .99, .96) })
      page.drawRectangle({ x: 30, y: y - 26, width: 535, height: 26, borderColor: line, borderWidth: .4 })
      draw(row.label, 42, y - 17, 8.5, row.bold, row.color)
      const amount = `${row.subtract && row.value > 0 ? '- ' : ''}${rupee(row.value)}`
      draw(amount, 553 - textWidth(amount, 9, true), y - 17, 9, true, row.color)
      y -= 26
    })
    const dueColor = breakdown.amountLeftPaise > 0 ? navy : green
    page.drawRectangle({ x: 30, y: y - 44, width: 535, height: 44, borderColor: dueColor, borderWidth: 1 })
    page.drawRectangle({ x: 30, y: y - 44, width: 232, height: 44, color: dueColor })
    draw(breakdown.amountLeftPaise > 0 ? 'AMOUNT LEFT TO PAY' : 'NOTHING LEFT TO PAY', 44, y - 27, 10.5, true, rgb(1, 1, 1))
    const amountLeft = rupee(breakdown.amountLeftPaise)
    draw(amountLeft, 548 - textWidth(amountLeft, 17, true), y - 30, 17, true, dueColor)
    y -= 58
    draw(`Total Bill in words: ${wordsForMoney(breakdown.totalBillPaise)}`, 30, y, 7.5, false, muted)
    y -= 27

    draw(breakdown.amountLeftPaise > 0 ? 'HOW TO PAY' : 'PAYMENT STATUS', 30, y, 9.5, true, orange)
    const instructions = breakdown.amountLeftPaise > 0
      ? [`Pay exactly ${rupee(breakdown.amountLeftPaise)}`, `UPI: ${settings.upiId || '-'}`, `Use reference: ${invoice.invoiceCode}`, 'Receipt is issued after the admin records payment.', `Help: Call or WhatsApp ${settings.phoneNumbers || '-'}`]
      : ['This bill is fully paid.', `Invoice reference: ${invoice.invoiceCode}`, `Help: Call or WhatsApp ${settings.phoneNumbers || '-'}`]
    instructions.forEach((item, index) => draw(`${index + 1}.  ${item}`, 40, y - 21 - index * 16, 7.8, false, ink))
    const paymentUri = invoicePaymentUri(invoice, settings)
    if (paymentUri) {
      const qrData = await QRCode.toDataURL(paymentUri, { margin: 1, width: 140 })
      const qr = await pdf.embedPng(decodeDataUrl(qrData))
      page.drawRectangle({ x: 438, y: y - 122, width: 117, height: 132, borderColor: navy, borderWidth: .7 })
      page.drawImage(qr, { x: 449, y: y - 94, width: 95, height: 95 })
      const qrCaption = `${rupee(breakdown.amountLeftPaise)} - ${invoice.invoiceCode}`
      draw(qrCaption, 496.5 - textWidth(qrCaption, 6.5, true) / 2, y - 111, 6.5, true, navy)
    }
  } else {
    const payment = data as PaymentDetail
    const breakdown = paymentDisplayBreakdown(payment)
    const paymentFields: Array<[string, string]> = [
      ['Payment Method', payment.paymentMode.toUpperCase()],
      ...(payment.paymentReference ? [['UTR / Reference', payment.paymentReference] as [string, string]] : []),
      ['Recorded By', 'Administrator'],
      ...(payment.notes ? [['Note', payment.notes] as [string, string]] : []),
    ]
    const customerFields: Array<[string, string]> = [
      ['Full Name', payment.customerName],
      ...(payment.customerCode ? [['Customer ID', payment.customerCode] as [string, string]] : []),
      ...(payment.stbNumber ? [['STB', payment.stbNumber] as [string, string]] : []),
      ...(payment.phone ? [['Mobile', payment.phone] as [string, string]] : []),
      ['Area', payment.areaName],
    ]
    const customerHeight = drawSection(30, 255, y, 'CUSTOMER', customerFields)
    const paymentHeight = drawSection(310, 255, y, 'PAYMENT DETAILS', paymentFields)
    y -= Math.max(customerHeight, paymentHeight) + 18

    draw('WHERE THIS PAYMENT WAS USED', 30, y, 9.5, true, navy)
    y -= 15
    page.drawRectangle({ x: 30, y: y - 23, width: 535, height: 23, color: navy })
    draw('BILL ITEM', 42, y - 15, 7.5, true, rgb(1, 1, 1))
    const amountHeading = 'Amount Covered'
    draw(amountHeading.toUpperCase(), 553 - textWidth(amountHeading.toUpperCase(), 7.5, true), y - 15, 7.5, true, rgb(1, 1, 1))
    y -= 23

    const allocations = Array.isArray(payment.allocations) ? payment.allocations : []
    const visibleAllocations = allocations.slice(0, 3)
    if (!visibleAllocations.length) {
      page.drawRectangle({ x: 30, y: y - 28, width: 535, height: 28, color: soft, borderColor: line, borderWidth: .4 })
      draw('Payment recorded to the customer account', 42, y - 18, 8.2, false, ink)
      y -= 28
    }
    for (const item of visibleAllocations) {
      const label = item.chargeType === 'opening_due' ? 'Old Unpaid Amount' : 'Monthly Service'
      const period = `${item.invoiceCode} | ${statementDate(item.periodStart)} to ${statementDate(item.periodEnd)}`
      const covered = Number(item.cashPaise || 0) + Number(item.discountPaise || 0) + Number(item.creditPaise || 0)
      page.drawRectangle({ x: 30, y: y - 34, width: 535, height: 34, color: soft, borderColor: line, borderWidth: .4 })
      draw(label, 42, y - 15, 8.3, true, ink)
      draw(truncateText(period, 350, 6.8, fonts.regular, fonts.gujarati), 42, y - 27, 6.8, false, rgb(.4, .48, .6))
      const coveredAmount = rupee(covered)
      draw(coveredAmount, 553 - textWidth(coveredAmount, 8.5, true), y - 21, 8.5, true, ink)
      y -= 34
    }
    if (allocations.length > visibleAllocations.length) {
      const remaining = `${allocations.length - visibleAllocations.length} more bill item(s) are saved in the customer account.`
      page.drawRectangle({ x: 30, y: y - 20, width: 535, height: 20, color: soft })
      draw(remaining, 42, y - 14, 7.2, false, rgb(.4, .48, .6))
      y -= 20
    }

    const receiptRows = [
      { label: 'Payment Received', value: breakdown.paymentReceivedPaise, color: rgb(.04, .43, .18), bold: true },
      { label: 'Discount Given', value: breakdown.discountGivenPaise, color: breakdown.discountGivenPaise > 0 ? rgb(.78, .36, .03) : rgb(.4, .48, .6), bold: breakdown.discountGivenPaise > 0 },
      ...(breakdown.customerCreditUsedPaise > 0 ? [{ label: 'Customer Credit Used', value: breakdown.customerCreditUsedPaise, color: navy, bold: false }] : []),
      { label: 'Total Bill Covered', value: breakdown.totalBillCoveredPaise, color: navy, bold: true },
    ]
    receiptRows.forEach((row, index) => {
      if (index === 0) page.drawRectangle({ x: 30, y: y - 24, width: 535, height: 24, color: rgb(.94, .99, .96) })
      else if (index === receiptRows.length - 1) page.drawRectangle({ x: 30, y: y - 24, width: 535, height: 24, color: rgb(.95, .97, 1) })
      page.drawRectangle({ x: 30, y: y - 24, width: 535, height: 24, borderColor: line, borderWidth: .4 })
      draw(row.label, 42, y - 17, 8.5, row.bold, row.color)
      const amount = rupee(row.value)
      draw(amount, 553 - textWidth(amount, 9, true), y - 17, 9, true, row.color)
      y -= 24
    })

    const unpaidColor = breakdown.amountStillUnpaidPaise > 0 ? red : green
    page.drawRectangle({ x: 30, y: y - 40, width: 535, height: 40, color: breakdown.amountStillUnpaidPaise > 0 ? rgb(1, .97, .97) : rgb(.95, .99, .96), borderColor: unpaidColor, borderWidth: .8 })
    draw(breakdown.amountStillUnpaidPaise > 0 ? 'AMOUNT STILL UNPAID' : 'NOTHING LEFT UNPAID', 42, y - 25, 9.5, true, unpaidColor)
    const unpaidAmount = rupee(breakdown.amountStillUnpaidPaise)
    draw(unpaidAmount, 553 - textWidth(unpaidAmount, 14, true), y - 27, 14, true, unpaidColor)
    y -= 53

    page.drawLine({ start: { x: 30, y }, end: { x: 565, y }, thickness: .55, color: line })
    draw('Customer Account Status', 30, y - 18, 8.2, true, ink)
    const accountStatus = breakdown.amountStillUnpaidPaise > 0 ? 'PARTLY PAID' : 'FULLY PAID'
    draw(accountStatus, 565 - textWidth(accountStatus, 8.5, true), y - 18, 8.5, true, breakdown.amountStillUnpaidPaise > 0 ? orange : green)
  }
  page.drawLine({ start: { x: 30, y: 35 }, end: { x: 565, y: 35 }, thickness: 1, color: navy })
  const footer = variant === 'invoice'
    ? `Thank you for choosing ${settings.businessName || 'Sitaram Billing'} | ${settings.upiId || ''} | Support: ${settings.phoneNumbers || ''} | Generated: ${generatedAt}`
    : `Computer Generated Receipt - No Signature Required | ${settings.businessName || 'Sitaram Billing'} | ${settings.phoneNumbers || ''} | Generated: ${generatedAt}`
  draw(truncateText(footer, 535, 6.8, fonts.regular, fonts.gujarati), 30, 20, 6.8, false, muted)
  return pdf.save({ useObjectStreams: false })
}

export async function invoicePdfBytes(invoice: InvoiceDetail, settings: BusinessSettings) { return createStatementPdf('invoice', invoice, settings) }
export async function receiptPdfBytes(payment: PaymentDetail, settings: BusinessSettings) { return createStatementPdf('receipt', payment, settings) }
export async function reportPdfBytes(report: Report, settings: BusinessSettings) {
  const rows: Row[] = [{ label: 'Report period', value: `${formatBusinessDate(report.from)} to ${formatBusinessDate(report.to)}` }, { label: 'Scope', value: report.scope.toUpperCase() }, { label: 'Billed', value: pdfMoney(report.billedPaise) }, { label: 'Collected', value: pdfMoney(report.collectedPaise) }, { label: 'Discount given', value: pdfMoney(report.discountGivenPaise) }, { label: 'Expenses', value: pdfMoney(report.expensePaise) }, { label: 'Outstanding', value: pdfMoney(report.outstandingPaise) }, { label: report.netLabel, value: pdfMoney(report.netPaise) }, { label: 'Active subscribers', value: String(report.activeSubscribers) }, { label: 'Subscriber records needing setup', value: String(report.dataQualityCount) }, ...report.payments.map((payment) => ({ label: payment.paymentCode, value: `${formatBusinessDate(payment.paymentDate)} | ${payment.customerName} | Received ${pdfMoney(payment.amountReceivedPaise)} | Discount ${pdfMoney(payment.discountGivenPaise)} | ${payment.paymentMode}` })), ...report.expenses.map((expense) => ({ label: `Expense ${expense.category}`, value: `${formatBusinessDate(expense.expenseDate)} | ${expense.description} | ${pdfMoney(expense.amountPaise)}` }))]
  return createPdfBytes('BUSINESS REPORT', report.scope.toUpperCase(), rows, settings)
}
export async function statementPdfBytes(customer: Customer, invoices: Invoice[], payments: Payment[], settings: BusinessSettings) {
  const balance = customer.amountDuePaise - customer.creditBalancePaise
  const rows: Row[] = [
    { label: 'Customer', value: `${customer.name} (${customer.customerCode})` },
    { label: 'Phone', value: customer.phone || '—' },
    { label: 'Area / STB', value: `${customer.areaName} / ${customer.stbNumber || '—'}` },
    { label: 'Plan', value: customer.planName || '—' },
    { label: 'Current balance', value: pdfMoney(Math.max(0, balance)) },
    { label: 'Advance credit', value: pdfMoney(customer.creditBalancePaise) },
    { label: 'Service coverage', value: customer.latestPeriodEnd ? (customer.latestPeriodStart ? `${formatBusinessDate(customer.latestPeriodStart)} to ${formatBusinessDate(customer.latestPeriodEnd)}` : `Through ${formatBusinessDate(customer.latestPeriodEnd)}`) : 'Not billed yet' },
    { label: 'Next billing start', value: customer.nextBillingStartDate ? formatBusinessDate(customer.nextBillingStartDate) : 'Not configured' },
    { label: 'Invoice history', value: invoices.length ? invoices.map((invoice) => `${invoice.invoiceCode}: ${formatBusinessDate(invoice.periodStart)} to ${formatBusinessDate(invoice.periodEnd)} | ${pdfMoney(invoice.totalPayablePaise)} | ${invoice.status}`).join('\n') : 'No invoices recorded' },
    { label: 'Payment history', value: payments.length ? payments.map((payment) => `${payment.paymentCode}: ${formatBusinessDate(payment.paymentDate)} | ${pdfMoney(payment.amountReceivedPaise)} | ${payment.paymentMode.toUpperCase()}${payment.paymentReference ? ` | Ref ${payment.paymentReference}` : ''}`).join('\n') : 'No payments recorded' },
  ]
  return createPdfBytes('CUSTOMER STATEMENT', customer.customerCode, rows, settings)
}
export function pdfPreviewUrl(bytes: Uint8Array) { return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })) }
export async function downloadInvoice(invoice: InvoiceDetail, settings: BusinessSettings) { saveBytes(`${invoice.invoiceCode}.pdf`, await invoicePdfBytes(invoice, settings)) }
export async function shareInvoice(invoice: InvoiceDetail, settings: BusinessSettings) { await shareOrDownload(`${invoice.invoiceCode}.pdf`, `${settings.businessName} invoice ${invoice.invoiceCode}`, await invoicePdfBytes(invoice, settings)) }
export async function downloadReceipt(payment: PaymentDetail, settings: BusinessSettings) { saveBytes(`${payment.paymentCode}.pdf`, await receiptPdfBytes(payment, settings)) }
export async function shareReceipt(payment: PaymentDetail, settings: BusinessSettings) { await shareOrDownload(`${payment.paymentCode}.pdf`, `${settings.businessName} receipt ${payment.paymentCode}`, await receiptPdfBytes(payment, settings)) }
export async function downloadStatement(customer: Customer, invoices: Invoice[], payments: Payment[], settings: BusinessSettings) { saveBytes(`${customer.customerCode}-statement.pdf`, await statementPdfBytes(customer, invoices, payments, settings)) }
export async function shareStatement(customer: Customer, invoices: Invoice[], payments: Payment[], settings: BusinessSettings) { await shareOrDownload(`${customer.customerCode}-statement.pdf`, `${settings.businessName} statement ${customer.customerCode}`, await statementPdfBytes(customer, invoices, payments, settings)) }

export async function downloadReportPdf(report: Report, settings: BusinessSettings) {
  saveBytes(`sitaram-report-${report.from}-${report.to}.pdf`, await reportPdfBytes(report, settings))
}

export function downloadReportExcel(report: Report) {
  const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows = [['Type', 'Code / Category', 'Name / Description', 'Date', 'Mode', 'Amount', 'Discount'], ['Summary', 'Billed', '', report.from + ' to ' + report.to, '', (report.billedPaise / 100).toFixed(2), ''], ['Summary', 'Collected', '', '', '', (report.collectedPaise / 100).toFixed(2), ''], ['Summary', 'Discount given', '', '', '', '', (report.discountGivenPaise / 100).toFixed(2)], ['Summary', 'Expenses', '', '', '', (report.expensePaise / 100).toFixed(2), ''], ['Summary', 'Outstanding', '', '', '', (report.outstandingPaise / 100).toFixed(2), ''], ['Summary', report.netLabel, '', '', '', (report.netPaise / 100).toFixed(2), ''], ['Summary', 'Active subscribers', String(report.activeSubscribers), '', '', '', ''], ['Summary', 'Records needing setup', String(report.dataQualityCount), '', '', '', ''], ...report.payments.map((p) => ['Collection', p.paymentCode, p.customerName, p.paymentDate, p.paymentMode, (p.amountReceivedPaise / 100).toFixed(2), (p.discountGivenPaise / 100).toFixed(2)]), ...report.expenses.map((e) => ['Expense', e.category, e.description, e.expenseDate, '', (e.amountPaise / 100).toFixed(2), ''])]
  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Report"><Table>${rows.map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="String">${escape(cell)}</Data></Cell>`).join('')}</Row>`).join('')}</Table></Worksheet></Workbook>`
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.ms-excel' })); Object.assign(document.createElement('a'), { href: url, download: `sitaram-report-${report.from}-${report.to}.xls` }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
