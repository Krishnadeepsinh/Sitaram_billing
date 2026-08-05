import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarRange, FileCheck2 } from 'lucide-react'
import { createInvoice, createPayment, getInvoicePreview } from '../lib/api'
import type { Customer, InvoicePreview, ServiceType } from '../lib/api'
import { addBillingDays, billingCyclePosition, formatBusinessDate, todayInBusinessTimezone } from '../lib/date'
import { formatRupees, rupeesToPaise } from '../lib/money'
import { PaymentAmountFields } from './PaymentAmountFields'

type InvoiceFormProps = {
  serviceType: ServiceType
  customers: Customer[]
  initialCustomerId?: number
  onCreated: (result: { invoiceCode: string; replayed: boolean; periodStart: string; periodEnd: string; paymentCode?: string }) => void
  onCancel: () => void
}

export function InvoiceForm({ serviceType, customers, initialCustomerId, onCreated, onCancel }: InvoiceFormProps) {
  const [customerId, setCustomerId] = useState(initialCustomerId ?? customers[0]?.id ?? 0)
  const [mode, setMode] = useState<'normal' | 'historical'>('normal')
  const [cycles, setCycles] = useState(1)
  const [restartChoice, setRestartChoice] = useState<'continuous' | 'restart' | ''>('')
  const [issuedDate, setIssuedDate] = useState(todayInBusinessTimezone())
  const [paymentDate, setPaymentDate] = useState(todayInBusinessTimezone())
  const [reason, setReason] = useState('')
  const [recordPayment, setRecordPayment] = useState(false)
  const [paymentMode, setPaymentMode] = useState<'cash' | 'upi'>('cash')
  const [paymentRequestKey, setPaymentRequestKey] = useState(() => crypto.randomUUID())
  const [preview, setPreview] = useState<InvoicePreview>()
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const customer = useMemo(() => customers.find((item) => item.id === customerId), [customerId, customers])
  const today = todayInBusinessTimezone()
  const hasInvoiceHistory = Boolean(customer?.latestPeriodEnd)
  const expired = mode === 'normal' && customer?.coverageStatus === 'expired'
  const needsRestartChoice = expired && !restartChoice
  const normalStart = restartChoice === 'restart' ? today : customer?.nextBillingStartDate ?? today
  const [startDate, setStartDate] = useState(normalStart)
  const normalStartChanged = mode === 'normal' && hasInvoiceHistory && startDate !== normalStart
  const validCycles = Number.isInteger(cycles) && cycles >= 1 && cycles <= 24
  const latestMissedPeriodStart = addBillingDays(today, 1 - (validCycles ? cycles : 1) * 30)
  const startsBeforeInstallation = Boolean(startDate && customer?.installationDate && startDate < customer.installationDate)
  const missedPeriodEndsInFuture = mode === 'historical' && validCycles && startDate > latestMissedPeriodStart
  const cashDueAfterCredit = preview && customer ? Math.max(0, preview.totalPayablePaise - customer.creditBalancePaise) : 0

  useEffect(() => {
    if (!customer) return
    setMode('normal')
    setCycles(1)
    setRestartChoice('')
    setStartDate(customer.nextBillingStartDate ?? todayInBusinessTimezone())
    setIssuedDate(todayInBusinessTimezone())
    setPaymentDate(todayInBusinessTimezone())
    setReason('')
    setRecordPayment(false)
    setPaymentMode('cash')
    setPaymentRequestKey(crypto.randomUUID())
    setPreview(undefined)
    setError('')
  }, [customer])

  function changeMode(nextMode: 'normal' | 'historical') {
    setMode(nextMode)
    setRestartChoice('')
    setRecordPayment(false)
    setError('')
    if (!customer) return
    setStartDate(nextMode === 'normal' ? customer.nextBillingStartDate ?? today : customer.installationDate ?? today)
  }

  function chooseRestart(nextChoice: 'continuous' | 'restart') {
    setRestartChoice(nextChoice)
    setStartDate(nextChoice === 'restart' ? today : customer?.nextBillingStartDate ?? today)
    setError('')
  }

  function changeStartDate(nextDate: string) {
    setPreview(undefined)
    setStartDate(nextDate)
    setError('')
  }

  useEffect(() => {
    if (!customer || !startDate || !validCycles || needsRestartChoice || normalStartChanged || startsBeforeInstallation || missedPeriodEndsInFuture) {
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
  }, [customer, cycles, missedPeriodEndsInFuture, mode, needsRestartChoice, normalStartChanged, serviceType, startDate, startsBeforeInstallation, validCycles])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!customer?.nextBillingStartDate || !preview || needsRestartChoice || normalStartChanged || startsBeforeInstallation || missedPeriodEndsInFuture) return
    if (preview.conflict) return setError(`Nothing was created. ${preview.conflict.invoiceCode} (${preview.conflict.status}) already covers ${formatBusinessDate(preview.conflict.periodStart)} to ${formatBusinessDate(preview.conflict.periodEnd)}. Choose dates that are fully available.`)
    setSubmitting(true)
    setError('')
    let invoiceCode = ''
    try {
      const result = await createInvoice(serviceType, {
        customerId: customer.id,
        monthsBilled: cycles,
        expectedPeriodStart: restartChoice === 'restart' ? today : customer.nextBillingStartDate,
        periodStart: startDate,
        issuedDate,
        billingMode: mode,
        historicalReason: mode === 'historical' ? reason : undefined,
        restartService: mode === 'normal' && restartChoice === 'restart',
      })
      invoiceCode = result.invoiceCode
      let paymentCode: string | undefined
      if (recordPayment && cashDueAfterCredit > 0) {
        const data = new FormData(event.currentTarget)
        const payment = await createPayment(serviceType, {
          customerId: customer.id,
          paymentDate,
          amountReceivedPaise: rupeesToPaise(String(data.get('amount'))),
          discountGivenPaise: rupeesToPaise(String(data.get('discount') || '0')),
          paymentMode,
          paymentReference: String(data.get('paymentReference') || '').trim() || undefined,
          notes: `Recorded with recharge ${result.invoiceCode}`,
          requestKey: paymentRequestKey,
        })
        paymentCode = payment.paymentCode
        setPaymentRequestKey(crypto.randomUUID())
      }
      onCreated({ ...result, paymentCode })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to create this recharge.'
      setError(invoiceCode ? `${invoiceCode} was created, but the payment was not recorded. Fix the payment details and submit again; the bill will not be duplicated. ${message}` : message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!customer) {
    return <div className="modal-empty-state" role="status">
      <strong>No customer is available</strong>
      <p>Add a customer and assign a plan before creating a recharge.</p>
      <button type="button" className="secondary" onClick={onCancel}>Close</button>
    </div>
  }

  return <form className="modal-form single-column invoice-workflow" onSubmit={submit}>
    <div className="modal-form-body">
      <header className="workflow-intro">
        <span className="workflow-icon"><CalendarRange size={19} aria-hidden="true" /></span>
        <span><strong>{mode === 'normal' ? 'Add Service Recharge' : 'Add an Older Bill'}</strong><small>{mode === 'normal' ? 'Choose the service length and check the total before saving.' : 'Use only for service dates that were provided but never billed.'}</small></span>
        <button type="button" className="text-button" onClick={() => changeMode(mode === 'normal' ? 'historical' : 'normal')}>{mode === 'normal' ? 'Add Older Bill' : 'Back to Recharge'}</button>
      </header>

      {!initialCustomerId ? <label>Customer *<select name="customerId" autoComplete="off" value={customerId || ''} onChange={(event) => setCustomerId(Number(event.target.value))} required><option value="" disabled>Select customer</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.customerCode}</option>)}</select></label> : null}

      {customer ? <div className="quick-action-context"><CalendarRange size={18} aria-hidden="true" /><span><strong>{customer.name}</strong><small>{customer.planName || 'No plan'} · {customer.latestPeriodEnd ? `Active until ${formatBusinessDate(customer.latestPeriodEnd)}` : 'Service not started'} · {customer.amountDuePaise > 0 ? `${formatRupees(customer.amountDuePaise)} unpaid` : 'No unpaid balance'}</small></span></div> : null}

      {expired ? <fieldset className="restart-choice"><legend>How should service continue after {formatBusinessDate(addBillingDays(customer!.latestPeriodEnd!, 1))}?</legend><p>Confirm whether the customer actually had service during the gap.</p><div><label className={restartChoice === 'restart' ? 'selected' : ''}><input type="radio" name="restartChoice" checked={restartChoice === 'restart'} onChange={() => chooseRestart('restart')} /><span><strong>Service stopped — restart today</strong><small>No charge for the inactive days. The new service period starts today.</small></span></label><label className={restartChoice === 'continuous' ? 'selected' : ''}><input type="radio" name="restartChoice" checked={restartChoice === 'continuous'} onChange={() => chooseRestart('continuous')} /><span><strong>Service continued — keep billing</strong><small>Continue from {formatBusinessDate(customer!.nextBillingStartDate!)} so there is no coverage gap.</small></span></label></div></fieldset> : null}

      <fieldset className="recharge-length"><legend>{mode === 'normal' ? 'Recharge Length' : 'Older Service Length'} *</legend><div role="group" aria-label="Choose service length">{[1, 2, 3].map((value) => <button type="button" key={value} className={cycles === value ? 'selected' : ''} aria-pressed={cycles === value} onClick={() => setCycles(value)}><strong>{value * 30} Days</strong><small>{value === 1 ? '1 period' : `${value} periods`}</small></button>)}</div><details className="custom-recharge-length"><summary>Custom duration</summary><label>Custom 30-Day Periods<input name="monthsBilled" type="number" autoComplete="off" min="1" max="24" value={cycles} onChange={(event) => setCycles(Number(event.target.value))} required /></label><small className="field-help">The operation is all-or-nothing. If any selected date is already billed, nothing new is created.</small></details></fieldset>

      {mode === 'historical' ? <><div className="billing-date-fields"><label>Older Service Starts *<input name="periodStart" type="date" autoComplete="off" value={startDate} min={customer?.installationDate ?? undefined} max={latestMissedPeriodStart} onChange={(event) => changeStartDate(event.target.value)} required aria-describedby="billing-eligibility" /><small className="field-help">Every selected 30-day period must have ended today or earlier.</small>{startsBeforeInstallation ? <small className="field-error-inline" role="alert">Service cannot start before installation on {formatBusinessDate(customer!.installationDate!)}.</small> : missedPeriodEndsInFuture ? <small className="field-error-inline" role="alert">Choose {formatBusinessDate(latestMissedPeriodStart)} or earlier so all {cycles} periods have ended.</small> : null}</label><label>Invoice Date *<input name="issuedDate" type="date" autoComplete="off" value={issuedDate} max={today} onChange={(event) => setIssuedDate(event.target.value)} required /><small className="field-help">Use the date this bill was originally issued.</small></label></div><label>Reason for Older Bill *<textarea name="historicalReason" autoComplete="off" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={250} required placeholder="Example: Service dates found during account review…" /><small className="field-help">This reason is saved in the audit history.</small></label></> : null}

      {mode === 'normal' && !needsRestartChoice ? <div className="billing-date-fields"><label>Service Starts *<input name="periodStart" type="date" autoComplete="off" value={startDate} min={customer?.installationDate ?? undefined} onChange={(event) => changeStartDate(event.target.value)} required aria-describedby="billing-eligibility" /><small className="field-help">{hasInvoiceHistory ? `Continuous service must start ${formatBusinessDate(normalStart)}. Use Add Older Bill for missed dates.` : 'Choose the first day covered by this recharge.'}</small>{normalStartChanged ? <small className="field-error-inline" role="alert">This account already has billing history. Continue from {formatBusinessDate(normalStart)} so service does not overlap or skip dates.</small> : null}</label><label>Invoice Date *<input name="issuedDate" type="date" autoComplete="off" value={issuedDate} max={today} onChange={(event) => setIssuedDate(event.target.value)} required /><small className="field-help">You can backdate this for a bill entered later.</small></label><span className="recharge-end">Service Ends<strong>{preview ? formatBusinessDate(preview.periodEnd) : 'Calculating…'}</strong></span></div> : null}

      {previewLoading ? <p className="form-help" aria-live="polite">Checking dates and amount…</p> : null}
      {needsRestartChoice ? <p className="eligibility neutral"><FileCheck2 size={16} aria-hidden="true" />Select one option above to calculate the correct billing start date and amount.</p> : null}
      {preview ? <section className="invoice-preview recharge-preview" aria-live="polite"><div><span>Service Period</span><strong>{formatBusinessDate(preview.periodStart)} – {formatBusinessDate(preview.periodEnd)}</strong></div><div><span>Plan</span><strong>{preview.planName || 'Plan missing'}</strong></div><div><span>Recharge Charge</span><strong>{formatRupees(preview.currentChargePaise)}</strong></div><div><span>Older Unpaid Amount</span><strong>{formatRupees(preview.previousDuePaise)}</strong></div><div><span>Active Until</span><strong>{formatBusinessDate(preview.periodEnd)}</strong></div><div className="preview-total"><span>Customer Will Owe</span><strong>{formatRupees(preview.totalPayablePaise)}</strong></div><p id="billing-eligibility" className={preview.conflict || !preview.planName ? 'eligibility conflict' : 'eligibility'}><FileCheck2 size={16} aria-hidden="true" />{preview.conflict ? `Blocked: ${preview.conflict.invoiceCode} (${preview.conflict.status}) already covers ${formatBusinessDate(preview.conflict.periodStart)} – ${formatBusinessDate(preview.conflict.periodEnd)}. Nothing will be created.` : !preview.planName ? 'No plan is assigned for these dates. Open the customer and add a plan first.' : mode === 'historical' ? `Ready to add an older bill. Regular recharges will still start ${formatBusinessDate(preview.currentNextBillingDate!)}.` : restartChoice === 'restart' ? `Ready to restart service today. The inactive gap before today will remain unbilled.` : `Ready. The next recharge will start ${formatBusinessDate(preview.nextEligibleDate)}.`}</p><details className="advanced-options"><summary>Calculation Details</summary><dl><div><dt>Bill Date</dt><dd>{formatBusinessDate(issuedDate)}</dd></div><div><dt>Payment Due</dt><dd>{formatBusinessDate(preview.dueDate)}</dd></div><div><dt>30-Day Price</dt><dd>{formatRupees(preview.pricePaise)}</dd></div><div><dt>Period Position</dt><dd>{billingCyclePosition(preview.periodStart, preview.periodEnd)}</dd></div></dl></details></section> : null}

      {mode === 'normal' && preview && !preview.conflict && preview.planName ? <section className="payment-with-recharge"><label className="check-row"><input type="checkbox" checked={recordPayment} disabled={cashDueAfterCredit <= 0} onChange={(event) => setRecordPayment(event.target.checked)} /><span><strong>Record Payment Now</strong><small>{cashDueAfterCredit > 0 ? `Save the recharge and payment together. Cash due after credit: ${formatRupees(cashDueAfterCredit)}.` : 'Existing credit will settle this recharge; no cash payment is needed.'}</small></span></label>{recordPayment ? <div className="payment-with-recharge-fields"><label>Payment Date *<input name="paymentDate" type="date" autoComplete="off" value={paymentDate} max={today} onChange={(event) => setPaymentDate(event.target.value)} required /></label><label>Payment Method<select name="paymentMode" value={paymentMode} onChange={(event) => setPaymentMode(event.target.value === 'upi' ? 'upi' : 'cash')}><option value="cash">Cash</option><option value="upi">UPI</option></select></label>{paymentMode === 'upi' ? <label>UPI Reference / UTR *<input name="paymentReference" autoComplete="off" maxLength={120} required placeholder="Enter the UPI transaction reference…" /></label> : null}<PaymentAmountFields key={`${customer.id}-${cashDueAfterCredit}`} duePaise={cashDueAfterCredit} /></div> : null}</section> : null}

      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={submitting || previewLoading || !preview || needsRestartChoice || normalStartChanged || startsBeforeInstallation || missedPeriodEndsInFuture || Boolean(preview.conflict) || !preview.planName || (mode === 'historical' && reason.trim().length < 5)}>{submitting ? 'Saving…' : recordPayment ? 'Recharge & Record Payment' : mode === 'historical' ? 'Create Older Bill' : 'Create Recharge'}</button></div>
  </form>
}
