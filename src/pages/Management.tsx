import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Archive, Clock, FileText, Info, Network, Pencil, Plus, RotateCcw, Search, Trash2, Users, Wallet, X } from 'lucide-react'
import { formatRupees, rupeesToPaise } from '../lib/money'
import { todayInBusinessTimezone } from '../lib/date'
import { createArea, createCustomer, createInvoice, createPayment, createPlan, deleteArea, deleteCustomer, listAreas, listCustomers, listPlans, updateArea, updateCustomer, updatePlan } from '../lib/api'
import type { Area, Customer, Plan, ServiceType } from '../lib/api'

type Notice = { kind: 'success' | 'error'; message: string } | undefined

const monthFormatter = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
function formatDuePeriod(customer: Customer) {
  if (!customer.oldestDuePeriodStart || !customer.latestDuePeriodEnd) return 'No pending invoice'
  const first = monthFormatter.format(new Date(`${customer.oldestDuePeriodStart}T00:00:00Z`))
  const last = monthFormatter.format(new Date(`${customer.latestDuePeriodEnd}T00:00:00Z`))
  return first === last ? first : `${first} – ${last}`
}

export function PlansPage({ serviceType }: { serviceType: ServiceType }) {
  const [plans, setPlans] = useState<Plan[]>([])
  const [editing, setEditing] = useState<Plan>()
  const [formOpen, setFormOpen] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const refresh = useCallback(() => { setLoading(true); listPlans(serviceType).then(setPlans).catch((error: Error) => setNotice({ kind: 'error', message: error.message })).finally(() => setLoading(false)) }, [serviceType])
  useEffect(() => { setEditing(undefined); setFormOpen(false); refresh() }, [refresh])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true)
    const form = new FormData(event.currentTarget)
    try {
      const values = { name: String(form.get('name')), pricePaise: rupeesToPaise(String(form.get('price'))), units: String(form.get('units')), isActive: form.get('isActive') === 'on' }
      if (editing) await updatePlan(serviceType, { id: editing.id, ...values }); else await createPlan(serviceType, values.name, values.pricePaise, values.units)
      setEditing(undefined); setFormOpen(false); setNotice({ kind: 'success', message: editing ? 'Plan updated.' : 'Plan saved.' }); refresh()
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to save plan.' }) }
    finally { setSubmitting(false) }
  }
  async function toggle(plan: Plan) { try { await updatePlan(serviceType, { id: plan.id, name: plan.name, pricePaise: plan.pricePaise, units: plan.units, isActive: !plan.isActive }); setNotice({ kind: 'success', message: `${plan.name} marked ${plan.isActive ? 'inactive' : 'active'}.` }); refresh() } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to update plan.' }) } }
  const openAdd = () => { setEditing(undefined); setFormOpen(true) }
  const openEdit = (plan: Plan) => { setEditing(plan); setFormOpen(true) }

  return <section className="page-content"><PageTitle title="Plans" subtitle="Manage your subscription packages and pricing." action={<button className="primary" onClick={openAdd}><Plus size={16} /> Add Plan</button>} />
    {notice && <NoticeMessage notice={notice} />}
    <article className="panel table-panel register-panel"><div className="register-heading"><h2>Active Plans</h2><span>{plans.length} total</span></div>{loading ? <p className="empty-inline">Loading plans…</p> : plans.length ? <div className="table-wrap"><table><thead><tr><th>Plan Name</th><th>Price</th><th>Duration</th><th>{serviceType === 'cable' ? 'Units' : 'Speed'}</th><th>Subscribers</th><th aria-label="Actions" /></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id}><td><span className="entity-cell"><i><Network size={16} /></i><span><strong>{plan.name}</strong><small>{plan.isActive ? 'Default' : 'Inactive'}</small></span></span></td><td><strong className="price-text">{formatRupees(plan.pricePaise)}</strong></td><td><span className="with-icon"><Clock size={14} />30 days</span></td><td>{plan.units || '—'}</td><td><span className="with-dot"><i className={plan.subscriberCount ? 'live' : ''} />{plan.subscriberCount} active</span></td><td><div className="action-row"><button className="icon-button" aria-label={`Edit ${plan.name}`} onClick={() => openEdit(plan)}><Pencil size={15} /></button><button className="icon-button" aria-label={`${plan.isActive ? 'Deactivate' : 'Activate'} ${plan.name}`} onClick={() => void toggle(plan)}>{plan.isActive ? <Archive size={15} /> : <RotateCcw size={15} />}</button></div></td></tr>)}</tbody></table></div> : <Empty label="No plans yet" text="Add your first plan to get started." />}</article>
    {formOpen && <Modal title={editing ? 'Edit Plan' : 'Create New Plan'} onClose={() => { setFormOpen(false); setEditing(undefined) }}><form className="modal-form" key={editing?.id ?? 'new'} onSubmit={submit}><label className="full-field">Plan Name<input name="name" autoComplete="off" required maxLength={100} defaultValue={editing?.name} placeholder="e.g. Standard Cable" /></label><label>Monthly Price (₹)<input name="price" autoComplete="off" inputMode="decimal" required pattern="\d+(\.\d{1,2})?" defaultValue={editing ? (editing.pricePaise / 100).toFixed(2) : ''} /></label><label>Validity (Days)<input value="30" disabled aria-label="Validity in days" /></label><label className="full-field">{serviceType === 'cable' ? 'Units / Reference' : 'Speed / Reference'}<input name="units" autoComplete="off" maxLength={120} defaultValue={editing?.units} /></label>{editing && <label className="check-row full-field"><input name="isActive" type="checkbox" defaultChecked={Boolean(editing.isActive)} /> Available for new customers</label>}<div className="modal-actions full-field"><button type="button" className="secondary" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary" disabled={submitting}>{submitting ? 'Saving…' : editing ? 'Update Plan' : 'Create Plan'}</button></div></form></Modal>}
  </section>
}

export function CustomersPage({ serviceType }: { serviceType: ServiceType }) {
  const [areas, setAreas] = useState<Area[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | Customer['status']>('all')
  const [areaFilter, setAreaFilter] = useState('all')
  const [planFilter, setPlanFilter] = useState('all')
  const [dueOnly, setDueOnly] = useState(false)
  const [editing, setEditing] = useState<Customer>()
  const [editingArea, setEditingArea] = useState<Area>()
  const [formOpen, setFormOpen] = useState(false)
  const [summary, setSummary] = useState<Customer>()
  const [quickInvoice, setQuickInvoice] = useState<Customer>()
  const [quickPayment, setQuickPayment] = useState<Customer>()
  const [deleting, setDeleting] = useState<Customer>()
  const [updatingStatus, setUpdatingStatus] = useState<number>()
  const [notice, setNotice] = useState<Notice>()
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const refresh = useCallback((search: string) => {
    setLoading(true)
    Promise.all([listAreas(serviceType), listPlans(serviceType), listCustomers(serviceType, search)])
      .then(([nextAreas, nextPlans, nextCustomers]) => { setAreas(nextAreas); setPlans(nextPlans); setCustomers(nextCustomers) })
      .catch((error: Error) => setNotice({ kind: 'error', message: error.message }))
      .finally(() => setLoading(false))
  }, [serviceType])
  useEffect(() => { setQuery(''); setEditing(undefined); setFormOpen(false); refresh('') }, [refresh])

  const filteredCustomers = useMemo(() => customers.filter((customer) =>
    (statusFilter === 'all' || customer.status === statusFilter) &&
    (areaFilter === 'all' || customer.areaId === Number(areaFilter)) &&
    (planFilter === 'all' || (planFilter === 'none' ? customer.planId === null : customer.planId === Number(planFilter))) &&
    (!dueOnly || customer.amountDuePaise > 0)
  ), [areaFilter, customers, dueOnly, planFilter, statusFilter])

  async function saveArea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const value = String(new FormData(form).get('area'))
    try { if (editingArea) await updateArea(serviceType, editingArea.id, value); else await createArea(serviceType, value); form.reset(); setEditingArea(undefined); setNotice({ kind: 'success', message: 'Area saved.' }); refresh(query) }
    catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to save area.' }) }
  }
  async function removeArea(area: Area) {
    if (!confirm(`Delete area “${area.displayName}”?`)) return
    try { await deleteArea(serviceType, area.id); setNotice({ kind: 'success', message: 'Area deleted.' }); refresh(query) }
    catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to delete area.' }) }
  }
  async function saveCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); const data = new FormData(event.currentTarget)
    try {
      const common = { name: String(data.get('name')), areaId: Number(data.get('areaId')), phone: String(data.get('phone')) || undefined, stbNumber: String(data.get('stbNumber')) || undefined, planId: Number(data.get('planId')) || undefined, installationDate: String(data.get('installationDate')) || undefined }
      if (editing) await updateCustomer(serviceType, { id: editing.id, ...common, status: data.get('status') === 'inactive' ? 'inactive' : 'active', restartDate: String(data.get('restartDate')) || undefined })
      else await createCustomer(serviceType, { ...common, openingBalancePaise: rupeesToPaise(String(data.get('openingBalance') || '0')), openingBalanceType: data.get('openingBalanceType') === 'advance' ? 'advance' : 'due' })
      setFormOpen(false); setEditing(undefined); setNotice({ kind: 'success', message: editing ? 'Subscriber updated.' : 'Subscriber saved.' }); refresh(query)
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to save subscriber.' }) }
    finally { setSubmitting(false) }
  }
  async function toggleStatus(customer: Customer) {
    const nextStatus = customer.status === 'active' ? 'inactive' : 'active'; setUpdatingStatus(customer.id)
    try {
      await updateCustomer(serviceType, { id: customer.id, name: customer.name, areaId: customer.areaId, phone: customer.phone ?? undefined, stbNumber: customer.stbNumber ?? undefined, planId: customer.planId ?? undefined, installationDate: customer.installationDate ?? undefined, status: nextStatus, restartDate: nextStatus === 'active' ? todayInBusinessTimezone() : undefined })
      setNotice({ kind: 'success', message: `${customer.name} is now ${nextStatus}.` }); refresh(query)
    } catch (error) { setNotice({ kind: 'error', message: `${error instanceof Error ? error.message : 'Unable to update status.'} Use Edit Subscriber if a restart date is required.` }) }
    finally { setUpdatingStatus(undefined) }
  }
  async function archiveCustomer() {
    if (!deleting) return; setSubmitting(true)
    try { await deleteCustomer(serviceType, deleting.id); setDeleting(undefined); setNotice({ kind: 'success', message: 'Subscriber archived. Financial history was retained.' }); refresh(query) }
    catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to archive subscriber.' }) }
    finally { setSubmitting(false) }
  }
  async function generateQuickInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!quickInvoice) return; setSubmitting(true)
    try { const months = Number(new FormData(event.currentTarget).get('months')); const result = await createInvoice(serviceType, quickInvoice.id, months); setQuickInvoice(undefined); setNotice({ kind: 'success', message: `${result.invoiceCode} created for ${quickInvoice.name}.` }); refresh(query) }
    catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to create invoice.' }) }
    finally { setSubmitting(false) }
  }
  async function collectQuickPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!quickPayment) return; setSubmitting(true); const data = new FormData(event.currentTarget)
    try {
      const result = await createPayment(serviceType, { customerId: quickPayment.id, paymentDate: String(data.get('paymentDate')), amountReceivedPaise: rupeesToPaise(String(data.get('amount'))), discountGivenPaise: rupeesToPaise(String(data.get('discount') || '0')), paymentMode: data.get('paymentMode') === 'upi' ? 'upi' : 'cash', notes: String(data.get('notes') || '') || undefined })
      setQuickPayment(undefined); setNotice({ kind: 'success', message: `${result.paymentCode} recorded for ${quickPayment.name}.` }); refresh(query)
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to record payment.' }) }
    finally { setSubmitting(false) }
  }
  const openAdd = () => { setEditing(undefined); setFormOpen(true) }
  const openEdit = (customer: Customer) => { setEditing(customer); setFormOpen(true) }

  return <section className="page-content">
    <PageTitle title="Subscribers" subtitle="Manage subscriber status, pending months, billing, and collections." action={<button className="primary" onClick={openAdd}><Plus size={16} /> Add Subscriber</button>} />
    {notice && <NoticeMessage notice={notice} />}
    <article className="panel customer-filters">
      <div className="search-row"><Search size={17} /><input name="subscriberSearch" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') refresh(query) }} placeholder="Search by name, ID, phone, STB, or area…" aria-label="Search subscribers" /><button className="secondary" onClick={() => refresh(query)}>Search</button></div>
      <div className="customer-filter-grid">
        <label className="due-toggle"><input type="checkbox" checked={dueOnly} onChange={(event) => setDueOnly(event.target.checked)} /><span>Pending Due Only</span></label>
        <label><span className="sr-only">Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">Status: All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <label><span className="sr-only">Area</span><select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}><option value="all">Area: All</option>{areas.map((area) => <option value={area.id} key={area.id}>{area.displayName}</option>)}</select></label>
        <label><span className="sr-only">Plan</span><select value={planFilter} onChange={(event) => setPlanFilter(event.target.value)}><option value="all">Plan: All</option><option value="none">No plan</option>{plans.map((plan) => <option value={plan.id} key={plan.id}>{plan.name}</option>)}</select></label>
      </div>
    </article>
    <article className="panel table-panel register-panel customer-register"><div className="register-heading"><h2>Subscriber Directory</h2><span>{filteredCustomers.length} shown</span></div>{loading ? <p className="empty-inline">Loading subscribers…</p> : filteredCustomers.length ? <div className="table-wrap"><table><thead><tr><th>Subscriber</th><th>STB / Area</th><th>Plan & Balance</th><th>Status</th><th aria-label="Actions">Actions</th></tr></thead><tbody>{filteredCustomers.map((customer) => {
      const canInvoice = customer.status === 'active' && Boolean(customer.planId && customer.installationDate && customer.nextBillingStartDate)
      return <tr key={customer.id}><td><span className="entity-cell"><i className="avatar">{customer.name.slice(0, 1).toUpperCase()}</i><span><strong>{customer.name}</strong><small>{customer.customerCode}{customer.phone ? ` · ${customer.phone}` : ''}</small></span></span></td><td><strong>{customer.stbNumber || 'N/A'}</strong><small>{customer.areaName}</small></td><td><div className="balance-cell"><span><strong>{customer.planName || 'No plan'}</strong><small className={customer.amountDuePaise > 0 ? 'amount-due' : customer.creditBalancePaise > 0 ? 'amount-credit' : ''}>{customer.amountDuePaise > 0 ? `${formatRupees(customer.amountDuePaise)} due` : customer.creditBalancePaise > 0 ? `${formatRupees(customer.creditBalancePaise)} advance` : 'Account settled'}</small></span><button className="icon-button info-button" aria-label={`View financial summary for ${customer.name}`} title="Financial summary" onClick={() => setSummary(customer)}><Info size={15} /></button>{customer.amountDuePaise > 0 ? <span className="due-period" title="Outstanding invoice period">{formatDuePeriod(customer)}</span> : null}</div></td><td><button className={`status-toggle ${customer.status}`} role="switch" aria-checked={customer.status === 'active'} aria-label={`${customer.name} is ${customer.status}. Switch to ${customer.status === 'active' ? 'inactive' : 'active'}.`} disabled={updatingStatus === customer.id} onClick={() => void toggleStatus(customer)}><i />{updatingStatus === customer.id ? 'Updating…' : customer.status}</button></td><td><div className="action-row customer-actions"><button className="icon-button action-invoice" aria-label={`Create invoice for ${customer.name}`} title={canInvoice ? 'Create invoice' : 'Active plan and installation date required'} disabled={!canInvoice} onClick={() => setQuickInvoice(customer)}><FileText size={16} /></button><button className="icon-button action-payment" aria-label={`Record payment for ${customer.name}`} title="Record payment" onClick={() => setQuickPayment(customer)}><Wallet size={16} /></button><button className="icon-button" aria-label={`Edit ${customer.name}`} title="Edit subscriber" onClick={() => openEdit(customer)}><Pencil size={16} /></button><button className="icon-button danger" aria-label={`Archive ${customer.name}`} title="Archive subscriber" onClick={() => setDeleting(customer)}><Trash2 size={16} /></button></div></td></tr>
    })}</tbody></table></div> : <Empty label="No subscribers found" text="Change the filters or add a subscriber." />}</article>

    {formOpen && <Modal title={editing ? `Edit ${editing.customerCode}` : 'Add Subscriber'} wide onClose={() => { setFormOpen(false); setEditing(undefined) }}><form className="inline-form area-form" key={editingArea?.id ?? 'new-area'} onSubmit={saveArea}><input name="area" autoComplete="off" required maxLength={120} defaultValue={editingArea?.displayName} aria-label={editingArea ? 'Area name' : 'New area name'} placeholder="Add a new area…" /><button type="submit" className="secondary">{editingArea ? 'Update' : 'Add Area'}</button></form>{areas.length > 0 && <div className="area-chips" aria-label="Service areas">{areas.map((area) => <span key={area.id}>{area.displayName}<button type="button" aria-label={`Edit ${area.displayName}`} onClick={() => setEditingArea(area)}><Pencil size={13} /></button><button type="button" aria-label={`Delete ${area.displayName}`} onClick={() => void removeArea(area)}><Trash2 size={13} /></button></span>)}</div>}<form className="modal-form customer-form" key={editing?.id ?? 'new'} onSubmit={saveCustomer}><label>Name *<input name="name" autoComplete="name" required maxLength={160} defaultValue={editing?.name} /></label><label>Area *<select name="areaId" required defaultValue={editing?.areaId ?? ''}><option value="" disabled>Select area</option>{areas.map((area) => <option key={area.id} value={area.id}>{area.displayName}</option>)}</select></label><label>Phone<input name="phone" type="tel" autoComplete="tel" maxLength={30} defaultValue={editing?.phone ?? ''} /></label><label>STB Number<input name="stbNumber" autoComplete="off" spellCheck={false} maxLength={80} defaultValue={editing?.stbNumber ?? ''} /></label><label>Plan<select name="planId" defaultValue={editing?.planId ?? ''}><option value="">No plan yet</option>{plans.filter((plan) => plan.isActive || plan.id === editing?.planId).map((plan) => <option key={plan.id} value={plan.id}>{plan.name} — {formatRupees(plan.pricePaise)}</option>)}</select></label><label>Installation Date<input name="installationDate" type="date" defaultValue={editing?.installationDate ?? ''} /></label>{editing ? <><label>Status<select name="status" defaultValue={editing.status}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>{editing.status === 'inactive' ? <label>Restart Date<input name="restartDate" type="date" defaultValue={todayInBusinessTimezone()} /></label> : null}</> : <><label>Opening Balance<input name="openingBalance" autoComplete="off" inputMode="decimal" defaultValue="0" pattern="\d+(\.\d{1,2})?" /></label><label>Balance Type<select name="openingBalanceType" defaultValue="due"><option value="due">Due (Dr)</option><option value="advance">Advance (Cr)</option></select></label></>}<div className="modal-actions full-field"><button type="button" className="secondary" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary" disabled={submitting || !areas.length}><Users size={16} /> {submitting ? 'Saving…' : editing ? 'Update Subscriber' : 'Add Subscriber'}</button></div></form></Modal>}
    {summary && <Modal title="Financial Summary" onClose={() => setSummary(undefined)}><div className="financial-summary"><div className="summary-customer"><i>{summary.name.slice(0, 1).toUpperCase()}</i><span><strong>{summary.name}</strong><small>{summary.customerCode} · {summary.planName || 'No plan'}</small></span></div><dl><div><dt>Pending invoice period</dt><dd>{formatDuePeriod(summary)}</dd></div><div><dt>Open invoices</dt><dd>{summary.openInvoiceCount}</dd></div><div><dt>Active plan dues</dt><dd className={summary.amountDuePaise > 0 ? 'amount-due' : ''}>{formatRupees(summary.amountDuePaise)}</dd></div><div><dt>Advance credit</dt><dd className={summary.creditBalancePaise > 0 ? 'amount-credit' : ''}>{formatRupees(summary.creditBalancePaise)}</dd></div><div className="summary-net"><dt>Net account position</dt><dd className={summary.amountDuePaise > 0 ? 'amount-due' : 'amount-credit'}>{summary.amountDuePaise > 0 ? `${formatRupees(summary.amountDuePaise)} due` : summary.creditBalancePaise > 0 ? `${formatRupees(summary.creditBalancePaise)} advance` : 'Settled'}</dd></div></dl><div className="modal-actions"><button className="secondary" onClick={() => { setSummary(undefined); openEdit(summary) }}>Edit Subscriber</button>{summary.amountDuePaise > 0 ? <button className="primary" onClick={() => { setSummary(undefined); setQuickPayment(summary) }}><Wallet size={16} /> Record Payment</button> : null}</div></div></Modal>}
    {quickInvoice && <Modal title="Create Invoice" onClose={() => setQuickInvoice(undefined)}><form className="modal-form single-column" onSubmit={generateQuickInvoice}><div className="quick-action-context"><FileText size={18} /><span><strong>{quickInvoice.name}</strong><small>Next billing starts {quickInvoice.nextBillingStartDate}</small></span></div><label>Billing Months<input name="months" type="number" min="1" max="24" defaultValue="1" required /></label><p className="form-help">The invoice period starts from the customer’s next billing date. Duplicate periods are prevented.</p><div className="modal-actions"><button type="button" className="secondary" onClick={() => setQuickInvoice(undefined)}>Cancel</button><button className="primary" disabled={submitting}>{submitting ? 'Creating…' : 'Create Invoice'}</button></div></form></Modal>}
    {quickPayment && <Modal title="Record Payment" onClose={() => setQuickPayment(undefined)}><form className="modal-form" onSubmit={collectQuickPayment}><div className="quick-action-context full-field"><Wallet size={18} /><span><strong>{quickPayment.name}</strong><small>Current due {formatRupees(quickPayment.amountDuePaise)}</small></span></div><label>Payment Date<input name="paymentDate" type="date" defaultValue={todayInBusinessTimezone()} required /></label><label>Mode<select name="paymentMode" defaultValue="cash"><option value="cash">Cash</option><option value="upi">UPI</option></select></label><label>Amount Received (₹)<input name="amount" autoComplete="off" inputMode="decimal" pattern="\d+(\.\d{1,2})?" defaultValue={quickPayment.amountDuePaise > 0 ? (quickPayment.amountDuePaise / 100).toFixed(2) : ''} required /></label><label>Discount (₹)<input name="discount" autoComplete="off" inputMode="decimal" pattern="\d+(\.\d{1,2})?" defaultValue="0" required /></label><label className="full-field">Notes<input name="notes" autoComplete="off" maxLength={500} placeholder="Optional collection note…" /></label><div className="modal-actions full-field"><button type="button" className="secondary" onClick={() => setQuickPayment(undefined)}>Cancel</button><button className="primary" disabled={submitting}>{submitting ? 'Recording…' : 'Record Payment'}</button></div></form></Modal>}
    {deleting && <Modal title="Archive Subscriber" onClose={() => setDeleting(undefined)}><div className="confirm-content"><span className="confirm-icon"><Trash2 size={20} /></span><div><h3>Archive {deleting.name}?</h3><p>Future billing will stop. Existing invoices, payments, and audit history will remain available in reports.</p></div><div className="modal-actions"><button className="secondary" onClick={() => setDeleting(undefined)}>Cancel</button><button className="primary danger-button" disabled={submitting} onClick={() => void archiveCustomer()}>{submitting ? 'Archiving…' : 'Archive Subscriber'}</button></div></div></Modal>}
  </section>
}

function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]') ?? [])
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const elements = focusable(); const first = elements[0]; const last = elements.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true" aria-labelledby="management-modal-title"><div className="modal-heading"><h2 id="management-modal-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>{children}</section></div>
}
function PageTitle({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) { return <div className="page-title"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div> }
function Empty({ label, text }: { label: string; text: string }) { return <div className="empty-list"><Users size={28} /><p>{label}</p><small>{text}</small></div> }
function NoticeMessage({ notice }: { notice: Exclude<Notice, undefined> }) { return <p className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{notice.message}</p> }
