import 'regenerator-runtime/runtime.js'
import fontkit, { type Font } from '@pdf-lib/fontkit'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import QRCode from 'qrcode'
import { toWords } from 'number-to-words'
import gujaratiFontUrl from '../assets/NotoSansGujarati-Regular.ttf?url'
import type { BusinessSettings, Customer, Invoice, InvoiceDetail, Payment, PaymentDetail, Report } from './api'
import { billingCyclePosition, formatBusinessDate } from './date'

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

function invoiceRows(invoice: InvoiceDetail): Row[] {
  return [
    { label: 'Billing date', value: formatBusinessDate(invoice.issuedDate) }, { label: 'Due date', value: formatBusinessDate(invoice.dueDate) },
    { label: 'Customer', value: invoice.customerName }, { label: 'Customer / STB ID', value: `${invoice.customerCode}${invoice.stbNumber ? ` / ${invoice.stbNumber}` : ''}` },
    { label: 'Area', value: invoice.areaName }, { label: 'Plan', value: invoice.planName }, { label: 'Service period', value: `${formatBusinessDate(invoice.periodStart)} to ${formatBusinessDate(invoice.periodEnd)}` },
    { label: 'Billing cycle position', value: billingCyclePosition(invoice.periodStart, invoice.periodEnd) },
    ...invoice.mergeItems.map((item) => ({ label: `Merged ${item.invoiceCode}`, value: `${item.planName} | ${formatBusinessDate(item.periodStart)} to ${formatBusinessDate(item.periodEnd)} | ${pdfMoney(item.amountPaise)}` })),
    { label: 'Previous due at issue', value: pdfMoney(invoice.previousDueSnapshotPaise) }, { label: 'Current period amount', value: pdfMoney(invoice.currentPeriodAmountPaise) },
    { label: 'Total payable at issue', value: pdfMoney(invoice.totalPayablePaise) }, { label: 'Live invoice balance', value: pdfMoney(invoice.liveBalancePaise) },
    ...invoice.allocations.map((item) => ({ label: `Payment ${item.paymentCode}`, value: `${formatBusinessDate(item.paymentDate)} | Cash ${pdfMoney(item.cashPaise)} | Discount ${pdfMoney(item.discountPaise)} | Credit ${pdfMoney(item.creditPaise)}` })),
    { label: 'Status', value: invoice.status.toUpperCase() },
  ]
}

function receiptRows(payment: PaymentDetail): Row[] {
  return [
    { label: 'Payment date', value: formatBusinessDate(payment.paymentDate) }, { label: 'Customer', value: payment.customerName }, { label: 'Customer / STB ID', value: `${payment.customerCode}${payment.stbNumber ? ` / ${payment.stbNumber}` : ''}` },
    { label: 'Area', value: payment.areaName }, { label: 'Payment mode', value: payment.paymentMode.replace('_', ' ').toUpperCase() }, { label: 'Amount received', value: pdfMoney(payment.amountReceivedPaise) },
    { label: 'Discount given', value: pdfMoney(payment.discountGivenPaise) }, { label: 'Notes', value: payment.notes || '—' },
    ...payment.allocations.map((item) => ({ label: `Allocated to ${item.invoiceCode} · ${item.chargeType === 'opening_due' ? 'Previous due' : 'Service charge'}`, value: `${formatBusinessDate(item.periodStart)} to ${formatBusinessDate(item.periodEnd)} | Cash ${pdfMoney(item.cashPaise)} | Discount ${pdfMoney(item.discountPaise)} | Credit ${pdfMoney(item.creditPaise)}` })),
    { label: 'Final status', value: payment.resultingStatus.replace('_', ' ').toUpperCase() },
  ]
}

void invoiceRows
void receiptRows
type StatementVariant = 'invoice' | 'receipt'
type StatementFonts = { regular: EmbeddedFont; bold: EmbeddedFont; gujarati: Font }
const statementDate = (value?: string) => { if (!value) return '—'; const [year, month, day] = value.split('-'); return `${day}/${month}/${year}` }
const wordsForMoney = (paise: number) => { const rupees = Math.floor(Math.abs(paise) / 100); const cents = Math.abs(paise) % 100; const phrase = `${toWords(rupees)}${cents ? ` rupees and ${toWords(cents)} paise` : ' rupees'} only`; return phrase.charAt(0).toUpperCase() + phrase.slice(1) }
const rupee = (paise: number) => paise > 0 ? `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''
function decodeDataUrl(value: string) { const encoded = value.split(',')[1] ?? ''; const binary = atob(encoded); return Uint8Array.from(binary, (character) => character.charCodeAt(0)) }

type StatementData = Record<string, any>
async function createStatementPdf(variant: StatementVariant, data: StatementData, settings: BusinessSettings) {
  const pdf = await PDFDocument.create(); const gujaratiBytes = await fetch(gujaratiFontUrl).then((response) => response.arrayBuffer())
  const fonts: StatementFonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold), gujarati: fontkit.create(new Uint8Array(gujaratiBytes)) }
  const accent = variant === 'invoice' ? rgb(.95, .25, .1) : rgb(.05, .63, .28); const navy = rgb(.1, .18, .36); const pale = variant === 'invoice' ? rgb(.99, .95, .9) : rgb(.91, .98, .93); const line = rgb(.87, .9, .94); const logo = await embedLogo(pdf, settings.logoUrl || '/logo.png')
  const serviceLabel = data.serviceType === 'broadband' ? 'Broadband Subscription' : 'Digital Cable TV'
  const generatedAt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date())
  const useLegacyReceiptLayout = Boolean((globalThis as { __legacyReceiptLayout?: boolean }).__legacyReceiptLayout)
  const page = pdf.addPage([595, 842]); const draw = (value: string, x: number, y: number, size = 10, bold = false, color = navy) => drawMixedText(page, value, value === 'AMOUNT RECEIVED' ? 238 : x, y, size, bold ? fonts.bold : fonts.regular, fonts.gujarati, color)
  const textWidth = (value: string, size: number, bold = false) => mixedTextWidth(value, size, bold ? fonts.bold : fonts.regular, fonts.gujarati)
  let lastRightY = Number.NaN; let sameRightY = 0
  const right = (value: string, y: number, size = 10, bold = false, color = navy) => { sameRightY = y === lastRightY ? sameRightY + 1 : 0; lastRightY = y; const edge = y < 400 ? 555 : sameRightY < 3 ? [410, 485, 555][sameRightY] : 555; draw(value, edge - textWidth(value, size, bold), y, size, bold, color) }
  page.drawRectangle({ x: 0, y: 748, width: 595, height: 94, color: navy })
  if (logo) page.drawImage(logo, { x: 30, y: 775, width: 62, height: 62 })
  draw('SITARAM CABLE & BROADBAND', 108, 812, 18, true, rgb(1, 1, 1)); draw('Connecting Every Home', 108, 795, 10, false, rgb(.8, .87, .95))
  draw(`Phone: ${settings.phoneNumbers || ''}   |   Address: ${settings.address || ''}`, 108, 778, 8.5, false, rgb(.82, .88, .95)); draw(`WhatsApp Support: ${settings.phoneNumbers || ''}   |   UPI: ${settings.upiId || '-'}`, 108, 762, 8.5, false, rgb(.82, .88, .95))
  page.drawRectangle({ x: 457, y: variant === 'invoice' ? 794 : 787, width: 108, height: variant === 'invoice' ? 28 : 42, color: accent, borderRadius: 5 })
  draw(variant === 'invoice' ? 'INVOICE' : 'OFFICIAL', 470, variant === 'invoice' ? 803 : 812, 9, true, rgb(1, 1, 1)); if (variant === 'receipt') draw('PAYMENT RECEIPT', 470, 798, 8.5, true, rgb(1, 1, 1))
  page.drawRectangle({ x: 0, y: 744, width: 595, height: 4, color: accent })
  const info = variant === 'invoice' ? [['INVOICE NO', data.invoiceCode], ['BILLING DATE', statementDate(data.issuedDate)], ['DUE DATE', statementDate(data.dueDate)], ['STATUS', data.status.toUpperCase()]] : [['RECEIPT NO', data.paymentCode], ['PAYMENT DATE', statementDate(data.paymentDate)], ['PAYMENT MODE', data.paymentMode.toUpperCase()], ['STATUS', 'SUCCESSFUL']]
  page.drawRectangle({ x: 0, y: 690, width: 595, height: 54, color: variant === 'invoice' ? rgb(.97, .98, 1) : rgb(.93, 1, .95) })
  info.forEach(([label, value], index) => { const x = index * 148.75; if (index) page.drawLine({ start: { x, y: 690 }, end: { x, y: 744 }, thickness: .5, color: line }); draw(label, x + 15, 724, 7.5, true, variant === 'invoice' ? rgb(.35, .42, .55) : rgb(.05, .48, .22)); draw(value, x + 15, 704, 10, true, navy) })
  let y = 656
  if (variant === 'receipt') { page.drawRectangle({ x: 0, y: 560, width: 595, height: 96, color: rgb(.12, .52, .18) }); draw('AMOUNT RECEIVED', 0, 630, 10, true, rgb(1, 1, 1)); right(rupee(data.amountReceivedPaise), 590, 30, true, rgb(1, 1, 1)); right(`${wordsForMoney(data.amountReceivedPaise)}`, 570, 9, false, rgb(1, 1, 1)); const discountPaise = Number(data.discountGivenPaise || 0); const settledPaise = Number(data.settledAmountPaise || data.amountReceivedPaise + discountPaise); const summary = discountPaise > 0 ? `Received ${rupee(Number(data.amountReceivedPaise))}  +  Discount ${rupee(discountPaise)}  =  Settled ${rupee(settledPaise)}` : `Received ${rupee(Number(data.amountReceivedPaise))}  =  Settled ${rupee(settledPaise)}`; draw(summary, 130, 548, 8.5, true, rgb(.05, .48, .22)); y = 538 }
  const drawCard = (x: number, width: number, title: string, fields: Array<[string, string]>) => { const height = 28 + fields.length * 22; const bottom = y - height; page.drawRectangle({ x, y: bottom, width, height, color: rgb(.98, .99, 1), borderColor: line, borderWidth: .7 }); page.drawRectangle({ x, y: y - 28, width, height: 28, color: navy }); draw(title, x + 12, y - 18, 8.5, true, rgb(1, 1, 1)); fields.forEach(([label, value], index) => { const rowY = y - 50 - index * 22; draw(`${label}:`, x + 12, rowY, 8.5, false, rgb(.4, .48, .6)); draw(value, x + 104, rowY, 9, true, navy) }) }
  const card = drawCard
  if (variant === 'invoice') {
    const invoice = data as InvoiceDetail; const customerFields: Array<[string, string]> = [['Full Name', invoice.customerName], ...(invoice.stbNumber ? [['STB', invoice.stbNumber] as [string, string]] : []), ...(invoice.phone ? [['Mobile No', invoice.phone] as [string, string]] : []), ['Service Type', serviceLabel]]
    drawCard(30, 270, 'CUSTOMER INFORMATION', customerFields); drawCard(315, 250, 'INSTALLATION ADDRESS', [['Area', invoice.areaName]])
    y -= 148; draw('LINE ITEMS', 30, y, 9, true, accent); y -= 18; page.drawRectangle({ x: 30, y: y - 28, width: 535, height: 28, color: navy }); ['#', 'Plan Name', 'Service Period', 'Rate (Rs.)', 'Arrears (Rs.)', 'Amount (Rs.)'].forEach((label, index) => draw(label, [40, 68, 190, 350, 425, 505][index], y - 18, 7.5, true, rgb(1, 1, 1))); y -= 42; page.drawRectangle({ x: 30, y: y - 34, width: 535, height: 34, color: rgb(.98, .99, 1) }); draw('1', 40, y - 20, 8.5); draw(`${invoice.planName} (${invoice.periodStart.slice(5, 7)}/${invoice.periodStart.slice(2, 4)})`, 68, y - 20, 8.5); draw(`${statementDate(invoice.periodStart)} to ${statementDate(invoice.periodEnd)}`, 190, y - 20, 8.5); right(rupee(invoice.currentPeriodAmountPaise), y - 20, 8.5); right(rupee(invoice.previousDueSnapshotPaise), y - 20, 8.5); right(rupee(invoice.totalPayablePaise), y - 20, 8.5); y -= 60
    const totalX = 320; page.drawRectangle({ x: totalX, y: y - 88, width: 245, height: 88, borderColor: line, borderWidth: .7, borderRadius: 4 }); draw('Plan Amount:', totalX + 12, y - 24, 9); right(rupee(invoice.currentPeriodAmountPaise), y - 24, 9); draw(invoice.previousDueSnapshotPaise > 0 ? 'Previous Dues (Arrears):' : '', totalX + 12, y - 48, 9); right(rupee(invoice.previousDueSnapshotPaise), y - 48, 9); page.drawRectangle({ x: totalX, y: y - 88, width: 245, height: 31, color: navy }); draw('GRAND TOTAL:', totalX + 12, y - 77, 11, true, rgb(1, 1, 1)); right(rupee(invoice.totalPayablePaise), y - 77, 11, true, rgb(1, 1, 1)); y -= 112
    page.drawRectangle({ x: 30, y: y - 28, width: 535, height: 28, color: rgb(.94, .96, .99), borderColor: line, borderWidth: .6, borderRadius: 3 }); draw(`Amount in Words: ${wordsForMoney(invoice.totalPayablePaise)}`, 42, y - 17, 9, false, navy); y -= 60; draw('PAYMENT INSTRUCTIONS', 30, y, 9, true, accent); const instructions = [`Pay via UPI: ${settings.upiId || '—'}`, 'Accepted: GPay / PhonePe / Paytm', 'Office Payment: Cash also accepted at office', 'Confirmation: Share screenshot after payment', `Support: Call/WhatsApp: ${settings.phoneNumbers || '—'}`]; instructions.forEach((item, index) => draw(`${index + 1}.  ${item}`, 40, y - 22 - index * 18, 8.5, false, navy)); if (settings.upiId) { const qrData = await QRCode.toDataURL(`upi://pay?pa=${settings.upiId}&pn=${encodeURIComponent(settings.businessName || 'Sitaram Cable')}&cu=INR`, { margin: 1, width: 140 }); const qr = await pdf.embedPng(decodeDataUrl(qrData)); page.drawRectangle({ x: 410, y: y - 112, width: 135, height: 140, color: rgb(.97, .98, 1), borderColor: line, borderWidth: .8, borderRadius: 4 }); draw('SCAN & PAY', 447, y + 10, 8.5, true, navy); page.drawImage(qr, { x: 424, y: y - 93, width: 108, height: 108 }); draw(`UPI: ${settings.upiId}`, 424, y - 105, 7, false, navy) }
  } else if (useLegacyReceiptLayout) {
    const payment = data; const paymentFields: Array<[string, string]> = [['Method', payment.paymentMode.toUpperCase()], ...(payment.paymentMode === 'upi' && settings.upiId ? [['Paid To', settings.upiId] as [string, string]] : []), ['Towards', payment.customerName ? 'Cable TV Subscription' : 'Subscription'], ['Service Period', payment.allocations[0] ? `${statementDate(payment.allocations[0].periodStart)} to ${statementDate(payment.allocations[0].periodEnd)}` : '—'], ['Transaction', 'CONFIRMED']]; const customerFields: Array<[string, string]> = [['Full Name', payment.customerName], ...(payment.stbNumber ? [['STB', payment.stbNumber] as [string, string]] : []), ...(payment.phone ? [['Mobile No', payment.phone] as [string, string]] : []), ['Area', payment.areaName], ['Service Type', 'Digital Cable TV'], ['Transaction ID', payment.paymentCode]]; card(30, 270, 'PAYMENT DETAILS', paymentFields); card(315, 250, 'CUSTOMER DETAILS', customerFields); y -= 180; draw('PAYMENT ALLOCATION DETAILS', 30, y, 9, true, rgb(.05, .63, .28)); y -= 18; page.drawRectangle({ x: 30, y: y - 28, width: 535, height: 28, color: navy }); draw('Item', 42, y - 18, 8, true, rgb(1, 1, 1)); right('Amount', y - 18, 8, true, rgb(1, 1, 1)); y -= 42; for (const item of payment.allocations) { draw(`Plan Subscription — ${item.periodStart.slice(5, 7)}/${item.periodStart.slice(2, 4)} (${statementDate(item.periodStart)} - ${statementDate(item.periodEnd)})`, 42, y - 18, 8.5, false, navy); right(rupee(item.cashPaise + item.discountPaise + item.creditPaise), y - 18, 8.5, true, navy); y -= 32 } draw('Subtotal', 42, y - 18, 9); right(rupee(payment.settledAmountPaise), y - 18, 9); y -= 34; page.drawRectangle({ x: 30, y: y - 34, width: 535, height: 34, color: rgb(.94, .96, .99) }); draw('Net Paid Amount:', 42, y - 22, 10, true, navy); right(rupee(payment.amountReceivedPaise), y - 22, 10, true, navy); y -= 52; page.drawRectangle({ x: 30, y: y - 30, width: 535, height: 30, color: pale }); draw('Current Status:', 42, y - 20, 9, true, navy); right(payment.resultingStatus === 'settled' ? 'FULLY PAID & CLEARED' : payment.resultingStatus.toUpperCase(), y - 20, 9, true, rgb(.05, .48, .22)); page.drawCircle({ x: 297, y: y - 88, size: 45, borderColor: rgb(.05, .5, .18), borderWidth: 2 }); draw('✓', 280, y - 82, 28, true, rgb(.05, .5, .18)); draw('VERIFIED', 265, y - 105, 10, true, rgb(.05, .5, .18)); draw('PAYMENT', 270, y - 120, 8, true, rgb(.05, .5, .18)); draw('CONFIRMED', 267, y - 134, 7, false, rgb(.05, .5, .18)) }
  else {
    const payment = data as PaymentDetail
    const discountPaise = Number(payment.discountGivenPaise || 0)
    const paymentFields: Array<[string, string]> = [['Payment mode', payment.paymentMode.toUpperCase()], ...(payment.paymentReference ? [['UTR / reference', payment.paymentReference] as [string, string]] : []), ['Amount received', rupee(Number(payment.amountReceivedPaise))], ...(discountPaise > 0 ? [['Discount given', rupee(discountPaise)] as [string, string]] : []), ['Settled amount', rupee(Number(payment.settledAmountPaise || payment.amountReceivedPaise + discountPaise))], ['Transaction', 'CONFIRMED']]
    const customerFields: Array<[string, string]> = [['Full Name', payment.customerName], ...(payment.customerCode ? [['Customer ID', payment.customerCode] as [string, string]] : []), ...(payment.stbNumber ? [['STB', payment.stbNumber] as [string, string]] : []), ...(payment.phone ? [['Mobile No', payment.phone] as [string, string]] : []), ['Area', payment.areaName], ['Service Type', serviceLabel], ['Transaction ID', payment.paymentCode]]
    drawCard(30, 270, 'PAYMENT DETAILS', paymentFields); drawCard(315, 250, 'CUSTOMER DETAILS', customerFields)
    y -= 204; draw('PAYMENT ALLOCATION DETAILS', 30, y, 9, true, rgb(.05, .63, .28)); y -= 18
    page.drawRectangle({ x: 30, y: y - 28, width: 535, height: 28, color: navy }); draw('Coverage', 42, y - 18, 8, true, rgb(1, 1, 1)); draw('Cash', 290, y - 18, 8, true, rgb(1, 1, 1)); draw('Discount', 365, y - 18, 8, true, rgb(1, 1, 1)); draw('Credit', 445, y - 18, 8, true, rgb(1, 1, 1)); right('Total', y - 18, 8, true, rgb(1, 1, 1)); y -= 42
    const allocations = Array.isArray(payment.allocations) ? payment.allocations : []; const visibleAllocations = allocations.slice(0, 7)
    for (const item of visibleAllocations) { const coverage = item.chargeType === 'opening_due' ? 'Previous due' : item.chargeType === 'plan' ? 'Current plan' : 'Service charge'; const period = `${statementDate(item.periodStart)} - ${statementDate(item.periodEnd)}`; const total = Number(item.cashPaise || 0) + Number(item.discountPaise || 0) + Number(item.creditPaise || 0); draw(`${coverage} (${period})`, 42, y - 18, 7.8, false, navy); draw(rupee(Number(item.cashPaise || 0)), 290, y - 18, 7.8, false, navy); draw(rupee(Number(item.discountPaise || 0)), 365, y - 18, 7.8, false, navy); draw(rupee(Number(item.creditPaise || 0)), 445, y - 18, 7.8, false, navy); right(rupee(total), y - 18, 7.8, true, navy); y -= 28 }
    if (allocations.length > visibleAllocations.length) { draw(`+ ${allocations.length - visibleAllocations.length} additional allocation(s)`, 42, y - 18, 8, false, rgb(.4, .48, .6)); y -= 24 }
    draw('Total settled', 42, y - 18, 9, true, navy); right(rupee(Number(payment.settledAmountPaise || payment.amountReceivedPaise + discountPaise)), y - 18, 9, true, navy); y -= 34
    page.drawRectangle({ x: 30, y: y - 32, width: 535, height: 32, color: rgb(.94, .96, .99), borderColor: line, borderWidth: .5 }); draw('Balance remaining:', 42, y - 21, 10, true, navy); const remainingPaise = Math.max(0, Number((payment as PaymentDetail & { liveBalancePaise?: number }).liveBalancePaise || 0)); right(remainingPaise > 0 ? rupee(remainingPaise) : 'Rs. 0.00', y - 21, 10, true, navy); y -= 48
    page.drawRectangle({ x: 30, y: y - 30, width: 535, height: 30, color: pale }); draw('Current Status:', 42, y - 20, 9, true, navy); right(payment.resultingStatus === 'settled' ? 'FULLY PAID & CLEARED' : payment.resultingStatus.toUpperCase(), y - 20, 9, true, rgb(.05, .48, .22)); page.drawCircle({ x: 297, y: y - 62, size: 32, borderColor: rgb(.05, .5, .18), borderWidth: 2 }); draw('V', 290, y - 55, 19, true, rgb(.05, .5, .18)); draw('PAYMENT VERIFIED', 247, y - 104, 8, true, rgb(.05, .5, .18))
  }
  page.drawRectangle({ x: 0, y: 0, width: 595, height: 28, color: navy }); draw(variant === 'invoice' ? `Thank you for choosing Sitaram Cable & Broadband | ${settings.upiId || ''} | Support: ${settings.phoneNumbers || ''} | Generated: ${generatedAt}` : `Computer Generated Receipt - No Signature Required | Sitaram Cable & Broadband | ${settings.phoneNumbers || ''} | Generated: ${generatedAt}`, 30, 10, 7.5, false, rgb(.82, .88, .95))
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
