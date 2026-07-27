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
  const accent = variant === 'invoice' ? rgb(.95, .25, .1) : rgb(.05, .63, .28); const navy = rgb(.1, .18, .36); const pale = variant === 'invoice' ? rgb(.99, .95, .9) : rgb(.91, .98, .93); const line = rgb(.87, .9, .94); const logo = await embedLogo(pdf, settings.logoUrl || '/logo.png')
  const serviceLabel = data.serviceType === 'broadband' ? 'Broadband Subscription' : 'Digital Cable TV'
  const generatedAt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date())
  const page = pdf.addPage([595, 842]); const draw = (value: string, x: number, y: number, size = 10, bold = false, color = navy) => drawMixedText(page, value, x, y, size, bold ? fonts.bold : fonts.regular, fonts.gujarati, color)
  const textWidth = (value: string, size: number, bold = false) => mixedTextWidth(value, size, bold ? fonts.bold : fonts.regular, fonts.gujarati)
  page.drawRectangle({ x: 0, y: 748, width: 595, height: 94, color: navy })
  if (logo) page.drawImage(logo, { x: 30, y: 775, width: 62, height: 62 })
  draw(truncateText(settings.businessName || 'Sitaram Cable & Broadband', 320, 18, fonts.bold, fonts.gujarati).toUpperCase(), 108, 812, 18, true, rgb(1, 1, 1)); draw('Connecting Every Home', 108, 795, 10, false, rgb(.8, .87, .95))
  draw(`Phone: ${settings.phoneNumbers || ''}   |   Address: ${settings.address || ''}`, 108, 778, 8.5, false, rgb(.82, .88, .95)); draw(`WhatsApp Support: ${settings.phoneNumbers || ''}   |   UPI: ${settings.upiId || '-'}`, 108, 762, 8.5, false, rgb(.82, .88, .95))
  page.drawRectangle({ x: 457, y: variant === 'invoice' ? 794 : 787, width: 108, height: variant === 'invoice' ? 28 : 42, color: accent, borderRadius: 5 })
  draw(variant === 'invoice' ? 'INVOICE' : 'OFFICIAL', 470, variant === 'invoice' ? 803 : 812, 9, true, rgb(1, 1, 1)); if (variant === 'receipt') draw('PAYMENT RECEIPT', 470, 798, 8.5, true, rgb(1, 1, 1))
  page.drawRectangle({ x: 0, y: 744, width: 595, height: 4, color: accent })
  const info = variant === 'invoice'
    ? [['INVOICE NO', data.invoiceCode], ['BILLING DATE', statementDate(data.issuedDate)], ['DUE DATE', statementDate(data.dueDate)], ['STATUS', invoiceStatusLabel(data.status, Number(data.liveBalancePaise || 0))]]
    : [['RECEIPT NO', data.paymentCode], ['PAYMENT DATE', statementDate(data.paymentDate)], ['PAYMENT METHOD', data.paymentMode.toUpperCase()], ['STATUS', 'PAYMENT RECORDED']]
  page.drawRectangle({ x: 0, y: 690, width: 595, height: 54, color: variant === 'invoice' ? rgb(.97, .98, 1) : rgb(.93, 1, .95) })
  info.forEach(([label, value], index) => { const x = index * 148.75; if (index) page.drawLine({ start: { x, y: 690 }, end: { x, y: 744 }, thickness: .5, color: line }); draw(label, x + 15, 724, 7.5, true, variant === 'invoice' ? rgb(.35, .42, .55) : rgb(.05, .48, .22)); draw(value, x + 15, 704, 10, true, navy) })
  let y = 656
  if (variant === 'receipt') {
    const paidAmount = rupee(Number(data.amountReceivedPaise || 0))
    const paidInWords = wordsForMoney(Number(data.amountReceivedPaise || 0))
    page.drawRectangle({ x: 0, y: 560, width: 595, height: 96, color: rgb(.06, .5, .2) })
    draw('AMOUNT PAID', 30, 620, 11, true, rgb(1, 1, 1))
    draw(paidAmount, 565 - textWidth(paidAmount, 29, true), 603, 29, true, rgb(1, 1, 1))
    draw(paidInWords, 565 - textWidth(paidInWords, 8.5), 580, 8.5, false, rgb(1, 1, 1))
    y = 538
  }
  const drawCard = (x: number, width: number, title: string, fields: Array<[string, string]>) => {
    const prepared = fields.map(([label, value]) => ({ label, lines: wrapText(value || '—', width - 116, 9, fonts.bold, fonts.gujarati) }))
    const rowHeights = prepared.map(({ lines }) => Math.max(20, lines.length * 11 + 4))
    const height = 34 + rowHeights.reduce((sum, value) => sum + value, 0)
    const bottom = y - height
    page.drawRectangle({ x, y: bottom, width, height, color: rgb(.98, .99, 1), borderColor: line, borderWidth: .7 })
    page.drawRectangle({ x, y: y - 28, width, height: 28, color: navy })
    draw(title, x + 12, y - 18, 8.5, true, rgb(1, 1, 1))
    let rowY = y - 48
    prepared.forEach(({ label, lines }, index) => {
      draw(`${label}:`, x + 12, rowY, 8.5, false, rgb(.4, .48, .6))
      lines.forEach((value, lineIndex) => draw(value, x + 104, rowY - lineIndex * 11, 9, true, navy))
      rowY -= rowHeights[index]
    })
    return height
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
    const customerCardHeight = drawCard(30, 270, 'CUSTOMER INFORMATION', customerFields)
    const serviceCardHeight = drawCard(315, 250, 'SERVICE DETAILS', serviceFields)
    y -= Math.max(customerCardHeight, serviceCardHeight) + 24
    draw('YOUR BILL', 30, y, 10, true, accent)
    y -= 18
    const billRows = [
      { label: 'Monthly Service', value: breakdown.monthlyServicePaise, background: rgb(.98, .99, 1), color: navy, bold: false },
      { label: 'Old Unpaid Amount', value: breakdown.oldUnpaidPaise, background: rgb(.98, .99, 1), color: navy, bold: false },
      { label: 'Total Bill', value: breakdown.totalBillPaise, background: navy, color: rgb(1, 1, 1), bold: true },
      { label: 'Payment Already Received', value: breakdown.paymentReceivedPaise, background: rgb(.93, .99, .95), color: rgb(.04, .43, .18), bold: true, subtract: true },
      { label: 'Discount Given', value: breakdown.discountGivenPaise, background: rgb(.99, .98, .95), color: breakdown.discountGivenPaise > 0 ? rgb(.78, .36, .03) : rgb(.4, .48, .6), bold: breakdown.discountGivenPaise > 0, subtract: true },
      ...(breakdown.customerCreditUsedPaise > 0 ? [{ label: 'Customer Credit Used', value: breakdown.customerCreditUsedPaise, background: rgb(.96, .98, 1), color: navy, bold: false, subtract: true }] : []),
    ]
    for (const row of billRows) {
      page.drawRectangle({ x: 30, y: y - 29, width: 535, height: 29, color: row.background, borderColor: line, borderWidth: .4 })
      draw(row.label, 42, y - 19, 9, row.bold, row.color)
      const amount = `${row.subtract && row.value > 0 ? '- ' : ''}${rupee(row.value)}`
      draw(amount, 553 - textWidth(amount, 9.5, true), y - 19, 9.5, true, row.color)
      y -= 29
    }
    page.drawRectangle({ x: 30, y: y - 48, width: 535, height: 48, color: navy, borderRadius: 4 })
    draw(breakdown.amountLeftPaise > 0 ? 'AMOUNT LEFT TO PAY' : 'NOTHING LEFT TO PAY', 44, y - 30, 12, true, rgb(1, 1, 1))
    const amountLeft = rupee(breakdown.amountLeftPaise)
    draw(amountLeft, 550 - textWidth(amountLeft, 19, true), y - 34, 19, true, rgb(1, 1, 1))
    y -= 62

    page.drawRectangle({ x: 30, y: y - 26, width: 535, height: 26, color: rgb(.96, .98, 1), borderColor: line, borderWidth: .5 })
    draw(`Total Bill in words: ${wordsForMoney(breakdown.totalBillPaise)}`, 42, y - 17, 8.3, false, navy)
    y -= 46

    draw(breakdown.amountLeftPaise > 0 ? 'HOW TO PAY' : 'PAYMENT STATUS', 30, y, 10, true, accent)
    const instructions = breakdown.amountLeftPaise > 0
      ? [`Pay exactly ${rupee(breakdown.amountLeftPaise)}`, `UPI: ${settings.upiId || '-'}`, `Use reference: ${invoice.invoiceCode}`, 'Receipt is issued after the admin records payment.', `Help: Call or WhatsApp ${settings.phoneNumbers || '-'}`]
      : ['This bill is fully paid.', `Invoice reference: ${invoice.invoiceCode}`, `Help: Call or WhatsApp ${settings.phoneNumbers || '-'}`]
    instructions.forEach((item, index) => draw(`${index + 1}.  ${item}`, 40, y - 22 - index * 16, 8, false, navy))
    const paymentUri = invoicePaymentUri(invoice, settings)
    if (paymentUri) {
      const qrData = await QRCode.toDataURL(paymentUri, { margin: 1, width: 140 })
      const qr = await pdf.embedPng(decodeDataUrl(qrData))
      page.drawRectangle({ x: 425, y: y - 126, width: 130, height: 140, color: rgb(.97, .98, 1), borderColor: line, borderWidth: .8, borderRadius: 4 })
      page.drawImage(qr, { x: 437, y: y - 98, width: 106, height: 106 })
      const qrCaption = `${rupee(breakdown.amountLeftPaise)} - ${invoice.invoiceCode}`
      draw(qrCaption, 490 - textWidth(qrCaption, 6.8, true) / 2, y - 113, 6.8, true, navy)
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
    const paymentCardHeight = drawCard(30, 270, 'PAYMENT INFORMATION', paymentFields)
    const customerCardHeight = drawCard(315, 250, 'CUSTOMER INFORMATION', customerFields)
    y -= Math.max(paymentCardHeight, customerCardHeight) + 24

    draw('WHERE THIS PAYMENT WAS USED', 30, y, 10, true, rgb(.05, .55, .24))
    y -= 18
    page.drawRectangle({ x: 30, y: y - 27, width: 535, height: 27, color: navy })
    draw('Bill Item', 42, y - 18, 8, true, rgb(1, 1, 1))
    const amountHeading = 'Amount Covered'
    draw(amountHeading, 553 - textWidth(amountHeading, 8, true), y - 18, 8, true, rgb(1, 1, 1))
    y -= 27

    const allocations = Array.isArray(payment.allocations) ? payment.allocations : []
    const visibleAllocations = allocations.slice(0, 3)
    if (!visibleAllocations.length) {
      page.drawRectangle({ x: 30, y: y - 30, width: 535, height: 30, color: rgb(.98, .99, 1), borderColor: line, borderWidth: .4 })
      draw('Payment recorded to the customer account', 42, y - 19, 8.5, false, navy)
      y -= 30
    }
    for (const item of visibleAllocations) {
      const label = item.chargeType === 'opening_due' ? 'Old Unpaid Amount' : 'Monthly Service'
      const period = `${item.invoiceCode} | ${statementDate(item.periodStart)} to ${statementDate(item.periodEnd)}`
      const covered = Number(item.cashPaise || 0) + Number(item.discountPaise || 0) + Number(item.creditPaise || 0)
      page.drawRectangle({ x: 30, y: y - 34, width: 535, height: 34, color: rgb(.98, .99, 1), borderColor: line, borderWidth: .4 })
      draw(label, 42, y - 15, 8.5, true, navy)
      draw(truncateText(period, 350, 6.8, fonts.regular, fonts.gujarati), 42, y - 27, 6.8, false, rgb(.4, .48, .6))
      const coveredAmount = rupee(covered)
      draw(coveredAmount, 553 - textWidth(coveredAmount, 8.5, true), y - 21, 8.5, true, navy)
      y -= 34
    }
    if (allocations.length > visibleAllocations.length) {
      const remaining = `${allocations.length - visibleAllocations.length} more bill item(s) are saved in the customer account.`
      page.drawRectangle({ x: 30, y: y - 20, width: 535, height: 20, color: rgb(.96, .98, 1) })
      draw(remaining, 42, y - 14, 7.2, false, rgb(.4, .48, .6))
      y -= 20
    }

    const receiptRows = [
      { label: 'Payment Received', value: breakdown.paymentReceivedPaise, color: rgb(.04, .43, .18), bold: true },
      { label: 'Discount Given', value: breakdown.discountGivenPaise, color: breakdown.discountGivenPaise > 0 ? rgb(.78, .36, .03) : rgb(.4, .48, .6), bold: breakdown.discountGivenPaise > 0 },
      ...(breakdown.customerCreditUsedPaise > 0 ? [{ label: 'Customer Credit Used', value: breakdown.customerCreditUsedPaise, color: navy, bold: false }] : []),
      { label: 'Total Bill Covered', value: breakdown.totalBillCoveredPaise, color: navy, bold: true },
    ]
    for (const row of receiptRows) {
      page.drawRectangle({ x: 30, y: y - 25, width: 535, height: 25, color: rgb(.98, .99, 1), borderColor: line, borderWidth: .4 })
      draw(row.label, 42, y - 17, 8.5, row.bold, row.color)
      const amount = rupee(row.value)
      draw(amount, 553 - textWidth(amount, 9, true), y - 17, 9, true, row.color)
      y -= 25
    }

    const unpaidColor = breakdown.amountStillUnpaidPaise > 0 ? rgb(.72, .13, .1) : rgb(.04, .43, .18)
    page.drawRectangle({ x: 30, y: y - 42, width: 535, height: 42, color: breakdown.amountStillUnpaidPaise > 0 ? rgb(1, .95, .95) : rgb(.93, .99, .95), borderColor: unpaidColor, borderWidth: .8, borderRadius: 4 })
    draw(breakdown.amountStillUnpaidPaise > 0 ? 'AMOUNT STILL UNPAID' : 'NOTHING LEFT UNPAID', 42, y - 27, 10.5, true, unpaidColor)
    const unpaidAmount = rupee(breakdown.amountStillUnpaidPaise)
    draw(unpaidAmount, 553 - textWidth(unpaidAmount, 15, true), y - 30, 15, true, unpaidColor)
    y -= 56

    page.drawRectangle({ x: 30, y: y - 28, width: 535, height: 28, color: pale })
    draw('Customer Account Status', 42, y - 19, 8.5, true, navy)
    const accountStatus = breakdown.amountStillUnpaidPaise > 0 ? 'PARTLY PAID' : 'FULLY PAID'
    draw(accountStatus, 553 - textWidth(accountStatus, 9, true), y - 19, 9, true, breakdown.amountStillUnpaidPaise > 0 ? rgb(.78, .36, .03) : rgb(.04, .43, .18))
  }
  page.drawRectangle({ x: 0, y: 0, width: 595, height: 28, color: navy }); draw(variant === 'invoice' ? `Thank you for choosing ${settings.businessName || 'Sitaram Billing'} | ${settings.upiId || ''} | Support: ${settings.phoneNumbers || ''} | Generated: ${generatedAt}` : `Computer Generated Receipt - No Signature Required | ${settings.businessName || 'Sitaram Billing'} | ${settings.phoneNumbers || ''} | Generated: ${generatedAt}`, 30, 10, 7.5, false, rgb(.82, .88, .95))
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
