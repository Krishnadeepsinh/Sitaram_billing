import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarRange, FileCheck2 } from 'lucide-react'
import { createInvoice, getInvoicePreview } from '../lib/api'
import type { Customer, InvoicePreview, ServiceType } from '../lib/api'
import { addBillingDays, billingCyclePosition, formatBusinessDate, todayInBusinessTimezone } from '../lib/date'
import { formatRupees } from '../lib/money'

type InvoiceFormProps = {
  serviceType: ServiceType
  customers: Customer[]
  initialCustomerId?: number
  onCreated: (result: { invoiceCode: string; replayed: boolean; periodStart: string; periodEnd: string }) => void
  onCancel: () => void
}

export function InvoiceForm({ serviceType, customers, initialCustomerId, onCreated, onCancel }: InvoiceFormProps) {
  const [customerId, setCustomerId] = useState(initialCustomerId ?? customers[0]?.id ?? 0)
  const [mode, setMode] = useState<'normal' | 'historical'>('normal')
  const [cycles, setCycles] = useState(1)
  const customer = useMemo(() => customers.find((item) => item.id === customerId), [customerId, customers])
  const today = todayInBusinessTimezone()
  const normalStart = customer?.nextBillingStartDate ?? today
  const [startDate, setStartDate] = useState(normalStart)
  const [issuedDate, setIssuedDate] = useState(today)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<InvoicePreview>()
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const normalStartChanged = mode === 'normal' && Boolean(startDate && customer?.latestPeriodEnd) && startDate < normalStart
  const validCycles = Number.isInteger(cycles) && cycles >= 1 && cycles <= 24
  const latestMissedPeriodStart = addBillingDays(today, 1 - (validCycles ? cycles : 1) * 30)
  const startsBeforeInstallation = Boolean(startDate && customer?.installationDate && startDate < customer.installationDate)
  const missedPeriodEndsInFuture = mode === 'historical' && validCycles && startDate > latestMissedPeriodStart

  useEffect(() => {
    if (!customer) return
    setMode('normal')
    setStartDate(customer.nextBillingStartDate ?? todayInBusinessTimezone())
    setReason('')
    setError('')
  }, [customer])

  function changeMode(nextMode: 'normal' | 'historical', preserveStartDate = false) {
    setMode(nextMode)
    setError('')
    if (!customer || preserveStartDate) return
    setStartDate(nextMode === 'normal' ? normalStart : customer.installationDate ?? today)
  }

  useEffect(() => {
    if (!customer || !startDate || !validCycles || startsBeforeInstallation || missedPeriodEndsInFuture) {
      setPreview(undefined)
      setPreviewLoading(false)
      return
    }
    setPreviewLoading(true)
    const timer = window.setTimeout(() => {
      getInvoicePreview(serviceType, { customerId: customer.id, monthsBilled: cycles, periodStart: startDate, billingMode: mode })
        .then((value) => { setPreview(value); setError('') })
        .catch((cause: Error) => { setPreview(undefined); setError(cause.message) })
        .finally(() => setPreviewLoading(false))
    }, 150)
    return () => { window.clearTimeout(timer); setPreviewLoading(false) }
  }, [customer, cycles, missedPeriodEndsInFuture, mode, serviceType, startDate, startsBeforeInstallation, validCycles])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!customer?.nextBillingStartDate || !preview || normalStartChanged || startsBeforeInstallation || missedPeriodEndsInFuture) return
    if (preview.conflict) return setError(`${preview.conflict.invoiceCode} already covers ${formatBusinessDate(preview.conflict.periodStart)} to ${formatBusinessDate(preview.conflict.periodEnd)}.`)
    setSubmitting(true)
    setError('')
    try {
      const result = await createInvoice(serviceType, { customerId: customer.id, monthsBilled: cycles, expectedPeriodStart: customer.nextBillingStartDate, periodStart: startDate, issuedDate, billingMode: mode, historicalReason: mode === 'historical' ? reason : undefined })
      onCreated(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create invoice.')
    } finally {
      setSubmitting(false)
    }
  }

  return <form className="modal-form single-column invoice-workflow" onSubmit={submit}>
    <div className="billing-mode-tabs" role="group" aria-label="Invoice type"><button type="button" className={mode === 'normal' ? 'active' : ''} aria-pressed={mode === 'normal'} onClick={() => changeMode('normal')}>Normal Renewal</button><button type="button" className={mode === 'historical' ? 'active' : ''} aria-pressed={mode === 'historical'} onClick={() => changeMode('historical')}>Missed Previous Period</button></div>
    {!initialCustomerId ? <label>Customer *<select name="customerId" value={customerId || ''} onChange={(event) => setCustomerId(Number(event.target.value))} required><option value="" disabled>Select customer</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.customerCode}</option>)}</select></label> : null}
    {customer ? <div className="quick-action-context"><CalendarRange size={18} aria-hidden="true" /><span><strong>{customer.name}</strong><small>{customer.latestPeriodEnd ? `Current coverage through ${formatBusinessDate(customer.latestPeriodEnd)}` : 'No previous coverage'} · Next start {formatBusinessDate(normalStart)}</small></span></div> : null}
    <div className="invoice-date-fields"><label>Invoice Date *<input name="issuedDate" type="date" value={issuedDate} max={today} onChange={(event) => setIssuedDate(event.target.value)} required /><small className="field-help">The accounting record date. It cannot be in the future.</small></label><label>Service Start Date *<input name="periodStart" type="date" value={startDate} min={customer?.installationDate ?? undefined} max={mode === 'historical' ? latestMissedPeriodStart : undefined} onChange={(event) => setStartDate(event.target.value)} required aria-describedby="billing-eligibility" /><small className="field-help">{mode === 'historical' ? 'Choose the start of the missed, fully completed service period.' : 'Choose when this renewal coverage begins. First invoices may start on or after installation.'}</small>{startsBeforeInstallation ? <small className="field-error-inline" role="alert">Service cannot start before installation on {formatBusinessDate(customer!.installationDate!)}.</small> : missedPeriodEndsInFuture ? <small className="field-error-inline" role="alert">Choose {formatBusinessDate(latestMissedPeriodStart)} or earlier so all {cycles} cycle{cycles === 1 ? '' : 's'} have ended.</small> : null}</label></div>
    {normalStartChanged && !startsBeforeInstallation ? <aside className="missed-period-prompt" role="alert"><span><strong>This date is before the next normal renewal.</strong><small>Use missed-period billing only if this older service period was never invoiced. Existing coverage cannot be billed twice.</small></span><button type="button" className="secondary" onClick={() => changeMode('historical', true)}>Bill This Missed Period</button></aside> : null}
    <label>30-Day Cycles *<input name="monthsBilled" type="number" min="1" max="24" value={cycles} onChange={(event) => setCycles(Number(event.target.value))} required /></label>
    {previewLoading ? <p className="form-help" aria-live="polite">Updating invoice preview…</p> : null}
    {preview ? <section className="invoice-preview" aria-live="polite"><div><span>Invoice date</span><strong>{formatBusinessDate(issuedDate)}</strong></div><div><span>Service start</span><strong>{formatBusinessDate(preview.periodStart)}</strong></div><div><span>Service period</span><strong>{formatBusinessDate(preview.periodStart)} – {formatBusinessDate(preview.periodEnd)}</strong></div><div><span>Plan</span><strong>{preview.planName || 'Unavailable'}</strong></div><div><span>Cycle position</span><strong>{billingCyclePosition(preview.periodStart, preview.periodEnd)}</strong></div><div><span>Cycle price</span><strong>{formatRupees(preview.pricePaise)}</strong></div><div><span>Current service charge</span><strong>{formatRupees(preview.currentChargePaise)}</strong></div><div><span>Previous due</span><strong>{formatRupees(preview.previousDuePaise)}</strong></div><div><span>Service expiry</span><strong>{formatBusinessDate(preview.periodEnd)}</strong></div><div><span>Payment due</span><strong>{formatBusinessDate(preview.dueDate)}</strong></div><div className="preview-total"><span>Total payable after creation</span><strong>{formatRupees(preview.totalPayablePaise)}</strong></div><p id="billing-eligibility" className={preview.conflict || !preview.planName ? 'eligibility conflict' : 'eligibility'}><FileCheck2 size={16} aria-hidden="true" />{preview.conflict ? `${preview.conflict.invoiceCode} already covers this range. Choose another uncovered period.` : !preview.planName ? 'No plan was assigned for this service date. Correct the subscriber plan history first.' : mode === 'historical' ? `This fills an older uncovered period. Normal renewal will remain ${formatBusinessDate(preview.nextEligibleDate)}.` : `After this invoice, the next eligible billing date is ${formatBusinessDate(preview.nextEligibleDate)}.`}</p></section> : null}
    {mode === 'historical' ? <label>Why Was This Period Missed? *<textarea name="historicalReason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={250} required placeholder="For example: June service was billed late after the record was found." /><small className="field-help">This explanation is saved in the audit history.</small></label> : <p className="form-help">Normal Renewal continues from the subscriber's latest coverage. To record an older period that was skipped, choose Missed Previous Period.</p>}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={submitting || previewLoading || !preview || normalStartChanged || startsBeforeInstallation || missedPeriodEndsInFuture || Boolean(preview.conflict) || !preview.planName || (mode === 'historical' && reason.trim().length < 5)}>{submitting ? 'Creating…' : mode === 'historical' ? 'Create Missed Invoice' : 'Generate Invoice'}</button></div>
  </form>
}
