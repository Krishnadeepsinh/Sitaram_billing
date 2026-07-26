import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarRange, FileCheck2 } from 'lucide-react'
import { createInvoice, getInvoicePreview } from '../lib/api'
import type { Customer, InvoicePreview, ServiceType } from '../lib/api'
import { billingCyclePosition, formatBusinessDate, todayInBusinessTimezone } from '../lib/date'
import { formatRupees } from '../lib/money'

export function InvoiceForm({ serviceType, customers, initialCustomerId, onCreated, onCancel }: { serviceType: ServiceType; customers: Customer[]; initialCustomerId?: number; onCreated: (result: { invoiceCode: string; replayed: boolean; periodStart: string; periodEnd: string }) => void; onCancel: () => void }) {
  const [customerId, setCustomerId] = useState(initialCustomerId ?? customers[0]?.id ?? 0)
  const [mode, setMode] = useState<'normal' | 'historical'>('normal')
  const [cycles, setCycles] = useState(1)
  const customer = useMemo(() => customers.find((item) => item.id === customerId), [customerId, customers])
  const normalStart = customer?.nextBillingStartDate ?? todayInBusinessTimezone()
  const [startDate, setStartDate] = useState(normalStart)
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<InvoicePreview>()
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!customer) return
    setStartDate(mode === 'normal' ? customer.nextBillingStartDate ?? todayInBusinessTimezone() : customer.installationDate ?? todayInBusinessTimezone())
  }, [customer, mode])
  useEffect(() => {
    if (!customer || !startDate || cycles < 1 || cycles > 24) return setPreview(undefined)
    const timer = window.setTimeout(() => {
      getInvoicePreview(serviceType, { customerId: customer.id, monthsBilled: cycles, periodStart: startDate, billingMode: mode })
        .then((value) => { setPreview(value); setError('') }).catch((cause: Error) => { setPreview(undefined); setError(cause.message) })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [customer, cycles, mode, serviceType, startDate])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!customer?.nextBillingStartDate || !preview) return
    if (preview.conflict) return setError(`${preview.conflict.invoiceCode} already covers ${formatBusinessDate(preview.conflict.periodStart)} to ${formatBusinessDate(preview.conflict.periodEnd)}.`)
    setSubmitting(true); setError('')
    try {
      const result = await createInvoice(serviceType, { customerId: customer.id, monthsBilled: cycles, expectedPeriodStart: customer.nextBillingStartDate, periodStart: startDate, billingMode: mode, historicalReason: mode === 'historical' ? reason : undefined })
      onCreated(result)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create invoice.') }
    finally { setSubmitting(false) }
  }

  return <form className="modal-form single-column invoice-workflow" onSubmit={submit}>
    <div className="billing-mode-tabs" role="group" aria-label="Invoice type"><button type="button" className={mode === 'normal' ? 'active' : ''} aria-pressed={mode === 'normal'} onClick={() => setMode('normal')}>Normal Renewal</button><button type="button" className={mode === 'historical' ? 'active' : ''} aria-pressed={mode === 'historical'} onClick={() => setMode('historical')}>Historical Gap</button></div>
    {!initialCustomerId ? <label>Customer *<select name="customerId" value={customerId || ''} onChange={(event) => setCustomerId(Number(event.target.value))} required><option value="" disabled>Select customer</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.customerCode}</option>)}</select></label> : null}
    {customer ? <div className="quick-action-context"><CalendarRange size={18} aria-hidden="true" /><span><strong>{customer.name}</strong><small>{customer.latestPeriodEnd ? `Current coverage through ${formatBusinessDate(customer.latestPeriodEnd)}` : 'No previous coverage'} · Next start {formatBusinessDate(normalStart)}</small></span></div> : null}
    <label>Service Start Date *<input name="periodStart" type="date" value={startDate} readOnly={mode === 'normal'} onChange={(event) => setStartDate(event.target.value)} required aria-describedby="billing-eligibility" /><small className="field-help">This is the only date you enter. The invoice record date is created automatically today. Normal renewal uses the next eligible date; Historical Gap allows an uncovered past period.</small></label><label>30-Day Cycles *<input name="monthsBilled" type="number" min="1" max="24" value={cycles} onChange={(event) => setCycles(Number(event.target.value))} required /></label>
    {preview ? <section className="invoice-preview" aria-live="polite"><div><span>Service start</span><strong>{formatBusinessDate(preview.periodStart)}</strong></div><div><span>Service period</span><strong>{formatBusinessDate(preview.periodStart)} – {formatBusinessDate(preview.periodEnd)}</strong></div><div><span>Invoice record date</span><strong>{formatBusinessDate(todayInBusinessTimezone())}</strong></div><div><span>Plan</span><strong>{preview.planName || 'Unavailable'}</strong></div><div><span>Cycle position</span><strong>{billingCyclePosition(preview.periodStart, preview.periodEnd)}</strong></div><div><span>Cycle price</span><strong>{formatRupees(preview.pricePaise)}</strong></div><div><span>Current service charge</span><strong>{formatRupees(preview.currentChargePaise)}</strong></div><div><span>Previous due</span><strong>{formatRupees(preview.previousDuePaise)}</strong></div><div><span>Service expiry</span><strong>{formatBusinessDate(preview.periodEnd)}</strong></div><div><span>Payment due</span><strong>{formatBusinessDate(preview.dueDate)}</strong></div><div className="preview-total"><span>Total payable after creation</span><strong>{formatRupees(preview.totalPayablePaise)}</strong></div><p id="billing-eligibility" className={preview.conflict ? 'eligibility conflict' : 'eligibility'}><FileCheck2 size={16} aria-hidden="true" />{preview.conflict ? `${preview.conflict.invoiceCode} already covers this range. Choose ${formatBusinessDate(preview.currentNextBillingDate || preview.nextEligibleDate)} or another uncovered date.` : `After this invoice, the next eligible billing date is ${formatBusinessDate(preview.nextEligibleDate)}.`}</p></section> : null}
    {mode === 'historical' ? <label>Historical Billing Reason *<textarea name="historicalReason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={250} required placeholder="Explain why this past period was not billed…" /></label> : <p className="form-help">Future non-overlapping renewals are allowed. Existing, merged, and deleted billing records are checked again by the server before creation.</p>}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={submitting || !preview || Boolean(preview.conflict) || (mode === 'historical' && reason.trim().length < 5)}>{submitting ? 'Creating…' : mode === 'historical' ? 'Create Historical Invoice' : 'Generate Invoice'}</button></div>
  </form>
}
