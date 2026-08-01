export async function apiHealth(): Promise<{ status: 'ok' | 'unavailable'; storage: 'local' | 'cloud' | 'unknown' }> {
  try {
    const response = await fetch('/api/health')
    return response.ok ? response.json() as Promise<{ status: 'ok'; storage: 'local' | 'cloud' }> : { status: 'unavailable', storage: 'unknown' }
  } catch {
    return { status: 'unavailable', storage: 'unknown' }
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'Request failed.' })) as { error?: string }
    if (response.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('sitaram:unauthorized'))
    throw new Error(data.error ?? 'Request failed.')
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export function login(username: string, password: string) {
  return request<{ username: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
}

export function currentAdmin() {
  return request<{ username: string }>('/api/auth/me')
}

export function logout() {
  return request<void>('/api/auth/logout', { method: 'POST' })
}

export type ServiceType = 'cable' | 'broadband'
export type PageResult<T> = { items: T[]; total: number; limit: number; offset: number }
export type Area = { id: number; displayName: string; serviceType?: ServiceType }
export type Plan = { id: number; name: string; pricePaise: number; units: string; isActive: number; subscriberCount: number }
export type Customer = { id: number; sortOrder: number; customerCode: string; name: string; phone: string | null; stbNumber: string | null; status: 'active' | 'inactive'; nextBillingStartDate: string | null; installationDate: string | null; areaId: number; planId: number | null; areaName: string; planName: string | null; planPricePaise: number | null; planIsActive: number; amountDuePaise: number; previousDuePaise: number; currentPlanDuePaise: number; futurePlanDuePaise: number; unbilledOpeningDuePaise: number; creditBalancePaise: number; openInvoiceCount: number; oldestDuePeriodStart: string | null; latestDuePeriodEnd: string | null; duePlanPeriodStart: string | null; duePlanCycleEndStart: string | null; latestPeriodStart: string | null; latestPeriodEnd: string | null; coverageStatus: 'never_billed' | 'future' | 'active' | 'expiring_today' | 'expired'; serviceStatus: 'active' | 'scheduled' | 'recharge_due' | 'not_billed' | 'suspended'; hasHistoricalGap: number; historicalGapStart: string | null; historicalGapEnd: string | null; historicalGapDays: number }
export type Invoice = { id: number; invoiceCode: string; customerId: number; customerName: string; periodStart: string; periodEnd: string; issuedDate: string; currentPeriodAmountPaise: number; previousDueSnapshotPaise: number; totalPayablePaise: number; chargeAmountPaise: number; balancePaise: number; status: string; dueDate: string; billingMode: 'normal' | 'historical'; isMerged: number; isCombined: number }
export type InvoiceDetail = Invoice & { serviceType: ServiceType; customerCode: string; phone?: string | null; areaName: string; planName: string; stbNumber: string | null; monthsBilled: number; currentPeriodAmountPaise: number; previousDueSnapshotPaise: number; liveBalancePaise: number; currentCustomerDuePaise: number; historicalReason?: string | null; charges: Array<{ chargeType: string; description: string; amountPaise: number }>; allocations: Array<{ paymentCode: string; paymentDate: string; periodStart: string; periodEnd: string; chargeType?: string | null; cashPaise: number; discountPaise: number; creditPaise: number }>; mergeItems: Array<{ invoiceCode: string; planName: string; periodStart: string; periodEnd: string; amountPaise: number }> }
export type Payment = { id: number; paymentCode: string; customerId: number; customerName: string; paymentDate: string; amountReceivedPaise: number; discountGivenPaise: number; settledAmountPaise: number; paymentMode: 'cash' | 'upi' | 'system_credit'; paymentReference?: string | null; resultingStatus: string; notes?: string | null; allocations?: Array<{ invoiceCode: string; periodStart: string; periodEnd: string; chargeType: string; cashPaise: number; discountPaise: number; creditPaise: number }> }
export type PaymentDetail = Payment & { serviceType: ServiceType; customerCode: string; phone?: string | null; stbNumber: string | null; areaName: string; liveBalancePaise: number; allocations: Array<{ invoiceCode: string; periodStart: string; periodEnd: string; chargeType?: string | null; cashPaise: number; discountPaise: number; creditPaise: number }> }
export type Expense = { id: number; description: string; amountPaise: number; expenseDate: string; category: string }
export type Report = { scope: ServiceType | 'all'; from: string; to: string; dateBasis: 'issued' | 'service'; billedPaise: number; collectedPaise: number; cashCollectedPaise: number; upiCollectedPaise: number; discountGivenPaise: number; todayCollectedPaise: number; outstandingPaise: number; activeSubscribers: number; expensePaise: number; netPaise: number; netLabel: string; dataQualityCount: number; payments: Payment[]; paymentTotal: number; expenses: Expense[]; expenseTotal: number; limit: number; offset: number; trends: Array<{ month: string; billedPaise: number; collectedPaise: number }>; expiringSoon: Array<{ id: number; customerCode: string; name: string; phone: string | null; periodEnd: string }>; areaBreakdown: Array<{ areaName: string; subscriberCount: number }> }
export type InvoiceDeletePreview = { invoiceCode: string; customerId: number; billingMode: string; periodStart: string; periodEnd: string; currentNextBillingDate: string; payments: Array<{ id: number; paymentCode: string; amountReceivedPaise: number; discountGivenPaise: number; sharedInvoiceCount: number }>; affectedInvoices: Array<{ invoiceCode: string }> }
export type PaymentDeletePreview = { paymentCode: string; customerId: number; amountReceivedPaise: number; discountGivenPaise: number; currentCreditPaise: number; invoices: Array<{ invoiceCode: string; status: string; allocatedPaise: number }> }
export type AuditEvent = { id: number; entityType: string; entityId: number; action: string; reason: string | null; details: Record<string, unknown>; createdBy: string; createdAt: string }
export type InvoicePreview = { customerName: string; periodStart: string; periodEnd: string; dueDate: string; monthsBilled: number; planName: string | null; pricePaise: number; currentChargePaise: number; previousDuePaise: number; totalPayablePaise: number; currentCoverageEnd: string | null; currentNextBillingDate: string | null; nextEligibleDate: string; conflict: { invoiceCode: string; periodStart: string; periodEnd: string; status: string } | null }
export type BusinessSettings = { businessName: string; address: string; phoneNumbers: string; upiId: string; logoUrl: string | null }

export function listAreas(serviceType: ServiceType) {
  return request<Area[]>(`/api/areas?serviceType=${serviceType}`)
}

export function createArea(serviceType: ServiceType, displayName: string) {
  return request<{ id: number; reused: boolean }>('/api/areas', { method: 'POST', body: JSON.stringify({ serviceType, displayName }) })
}
export function updateArea(serviceType: ServiceType, id: number, displayName: string) { return request<void>('/api/areas', { method: 'PUT', body: JSON.stringify({ serviceType, id, displayName }) }) }
export function deleteArea(serviceType: ServiceType, id: number) { return request<void>(`/api/areas?serviceType=${serviceType}&id=${id}`, { method: 'DELETE' }) }

export function listPlans(serviceType: ServiceType) {
  return request<Plan[]>(`/api/plans?serviceType=${serviceType}`)
}

export function createPlan(serviceType: ServiceType, name: string, pricePaise: number, units: string) {
  return request<{ id: number }>('/api/plans', { method: 'POST', body: JSON.stringify({ serviceType, name, pricePaise, units }) })
}
export function updatePlan(serviceType: ServiceType, input: { id: number; name: string; pricePaise: number; units: string; isActive: boolean }) { return request<void>('/api/plans', { method: 'PUT', body: JSON.stringify({ serviceType, ...input }) }) }

export function listCustomers(serviceType: ServiceType, query = '', includeDeleted = false, filters: { status?: string; areaId?: string; planId?: string; dueOnly?: boolean; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams({ serviceType, query, ...(includeDeleted ? { includeDeleted: '1' } : {}), limit: String(filters.limit ?? 100), offset: String(filters.offset ?? 0) })
  if (filters.status && filters.status !== 'all') params.set('status', filters.status)
  if (filters.areaId && filters.areaId !== 'all') params.set('areaId', filters.areaId)
  if (filters.planId && filters.planId !== 'all') params.set('planId', filters.planId)
  if (filters.dueOnly) params.set('dueOnly', '1')
  return request<PageResult<Customer>>(`/api/customers?${params}`)
}
export function updateCustomer(serviceType: ServiceType, input: { id: number; name: string; areaId: number; phone?: string; stbNumber?: string; planId?: number; installationDate?: string; status: 'active' | 'inactive'; restartDate?: string; statusReason?: string }) { return request<void>('/api/customers', { method: 'PUT', body: JSON.stringify({ serviceType, ...input }) }) }
export function deleteCustomer(serviceType: ServiceType, id: number, reason = '') { return request<void>(`/api/customers?serviceType=${serviceType}&id=${id}&reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }) }
export function archiveCustomers(serviceType: ServiceType, ids: number[], reason = '') { return request<{ archived: number }>('/api/customers', { method: 'POST', body: JSON.stringify({ action: 'archive_many', serviceType, ids, reason }) }) }
export function permanentlyDeleteArchivedCustomer(serviceType: ServiceType, id: number, reason = '') { return request<void>(`/api/customers?serviceType=${serviceType}&id=${id}&permanent=1&reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }) }
export function restoreCustomer(serviceType: ServiceType, id: number, reason = '') { return request<void>('/api/customers', { method: 'PATCH', body: JSON.stringify({ serviceType, id, reason }) }) }

export function createCustomer(serviceType: ServiceType, input: { name: string; areaId: number; phone?: string; stbNumber?: string; planId?: number; installationDate?: string; openingBalancePaise: number; openingBalanceType: 'due' | 'advance' }) {
  return request<{ id: number; customerCode: string }>('/api/customers', { method: 'POST', body: JSON.stringify({ serviceType, ...input }) })
}

export function listInvoices(serviceType: ServiceType, query = '', showMerged = false, offset = 0, filters: { status?: string; billingMode?: string; areaId?: string; from?: string; to?: string; limit?: string } = {}) { const params = new URLSearchParams({ serviceType, query, offset: String(offset), ...(showMerged ? { showMerged: '1' } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Record<string, string> }); return request<PageResult<Invoice>>(`/api/invoices?${params}`) }
export function getInvoice(serviceType: ServiceType, id: number) { return request<InvoiceDetail>(`/api/invoices?serviceType=${serviceType}&id=${id}`) }
export function getInvoicePreview(serviceType: ServiceType, input: { customerId: number; monthsBilled: number; periodStart: string; billingMode: 'normal' | 'historical' }) { const params = new URLSearchParams({ serviceType, previewCustomerId: String(input.customerId), monthsBilled: String(input.monthsBilled), periodStart: input.periodStart, billingMode: input.billingMode }); return request<InvoicePreview>(`/api/invoices?${params}`) }
export function listAuditEvents(input: { query?: string; entityType?: string; limit?: number; offset?: number } = {}) { const params = new URLSearchParams(); if (input.query) params.set('query', input.query); if (input.entityType) params.set('entityType', input.entityType); params.set('limit', String(input.limit ?? 25)); params.set('offset', String(input.offset ?? 0)); return request<{ items: AuditEvent[]; total: number; limit: number; offset: number }>(`/api/audit?${params}`) }
export function createInvoice(serviceType: ServiceType, input: { customerId: number; monthsBilled: number; expectedPeriodStart: string; periodStart?: string; issuedDate?: string; billingMode?: 'normal' | 'historical'; historicalReason?: string; restartService?: boolean }) { return request<{ invoiceCode: string; periodStart: string; periodEnd: string; nextEligibleDate: string; replayed: boolean }>('/api/invoices', { method: 'POST', body: JSON.stringify({ serviceType, ...input }) }) }
export type BulkInvoiceResult = { generated: Array<{ invoiceCode: string }>; ready: Array<{ customerId: number; customerCode: string; customerName: string; periodStart: string; periodEnd: string; cycles: number; amountPaise: number }>; skipped: Array<{ customerId: number; customerCode: string; customerName: string; reason: string }>; failed: Array<{ customerId: number; customerCode?: string; customerName?: string; reason: string }> }
export function bulkCreateInvoices(serviceType: ServiceType, throughMonth: string, customerIds?: number[], preview = false) { return request<BulkInvoiceResult>('/api/invoices/bulk', { method: 'POST', body: JSON.stringify({ serviceType, throughMonth, customerIds, preview }) }) }
export function mergeInvoices(serviceType: ServiceType, invoiceIds: number[]) { return request<{ invoiceId: number; invoiceCode: string }>('/api/invoices/merge', { method: 'POST', body: JSON.stringify({ serviceType, invoiceIds }) }) }
export function getInvoiceDeletePreview(serviceType: ServiceType, id: number) { return request<InvoiceDeletePreview>(`/api/invoices?serviceType=${serviceType}&deletePreview=${id}`) }
export function listPayments(serviceType: ServiceType, filters: { query?: string; from?: string; to?: string; mode?: string; offset?: string; limit?: string } = {}) { const params = new URLSearchParams({ serviceType, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')) as Record<string, string> }); return request<PageResult<Payment>>(`/api/payments?${params}`) }
export function getPayment(serviceType: ServiceType, id: number) { return request<PaymentDetail>(`/api/payments?serviceType=${serviceType}&id=${id}`) }
export function createPayment(serviceType: ServiceType, input: { customerId: number; paymentDate: string; amountReceivedPaise: number; discountGivenPaise: number; paymentMode: 'cash' | 'upi'; paymentReference?: string; notes?: string; requestKey: string }) { return request<{ paymentCode: string; replayed?: boolean }>('/api/payments', { method: 'POST', body: JSON.stringify({ serviceType, ...input }) }) }
export function getPaymentDeletePreview(serviceType: ServiceType, id: number) { return request<PaymentDeletePreview>(`/api/payments?serviceType=${serviceType}&deletePreview=${id}`) }
export function deleteInvoice(serviceType: ServiceType, invoiceId: number, reason: string) { return request<void>(`/api/invoices?serviceType=${serviceType}&id=${invoiceId}&reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }) }
export function deletePayment(serviceType: ServiceType, paymentId: number, reason: string) { return request<void>(`/api/payments?serviceType=${serviceType}&id=${paymentId}&reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }) }

async function allPages<T>(load: (offset: number) => Promise<PageResult<T>>) {
  const first = await load(0)
  const offsets = Array.from({ length: Math.max(0, Math.ceil(first.total / first.limit) - 1) }, (_, index) => (index + 1) * first.limit)
  const items = [...first.items]
  for (let index = 0; index < offsets.length; index += 4) {
    const pages = await Promise.all(offsets.slice(index, index + 4).map(load))
    items.push(...pages.flatMap((page) => page.items))
  }
  return items
}

export function listAllInvoices(serviceType: ServiceType, query = '', showMerged = false, filters: { status?: string; billingMode?: string; areaId?: string; from?: string; to?: string } = {}) {
  return allPages((offset) => listInvoices(serviceType, query, showMerged, offset, { ...filters, limit: '200' }))
}

export function listAllPayments(serviceType: ServiceType, filters: { query?: string; from?: string; to?: string; mode?: string } = {}) {
  return allPages((offset) => listPayments(serviceType, { ...filters, limit: '200', offset: String(offset) }))
}
export function listExpenses(filters: { from?: string; to?: string; category?: string } = {}) { const params = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Record<string, string>); return request<Expense[]>(`/api/expenses?${params}`) }
export function createExpense(input: { description: string; amountPaise: number; expenseDate: string; category: string }) { return request<{ id: number }>('/api/expenses', { method: 'POST', body: JSON.stringify(input) }) }
export function deleteExpense(id: number, reason: string) { return request<void>(`/api/expenses?id=${id}&reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }) }
export function getReport(serviceType: ServiceType | 'all', filters: { from?: string; to?: string; areaId?: string; paymentMode?: string; discountGiven?: string; dateBasis?: string; limit?: string; offset?: string } = {}) { const params = new URLSearchParams({ serviceType, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== '')) as Record<string, string> }); return request<Report>(`/api/reports?${params}`) }
export async function getCompleteReport(serviceType: ServiceType | 'all', filters: { from?: string; to?: string; areaId?: string; paymentMode?: string; discountGiven?: string; dateBasis?: string } = {}) {
  const first = await getReport(serviceType, { ...filters, limit: '500', offset: '0' })
  if (first.paymentTotal <= first.payments.length && first.expenseTotal <= first.expenses.length) return first
  const pages: Report[] = []
  const remaining = Math.ceil(Math.max(first.paymentTotal, first.expenseTotal) / 500) - 1
  for (let start = 0; start < remaining; start += 4) {
    const batchSize = Math.min(4, remaining - start)
    pages.push(...await Promise.all(Array.from({ length: batchSize }, (_, index) => getReport(serviceType, { ...filters, limit: '500', offset: String((start + index + 1) * 500) }))))
  }
  return { ...first, payments: [first, ...pages].flatMap((page) => page.payments), expenses: [first, ...pages].flatMap((page) => page.expenses) }
}
export function getSettings() { return request<BusinessSettings | null>('/api/settings') }
export function saveSettings(input: BusinessSettings) { return request<void>('/api/settings', { method: 'PUT', body: JSON.stringify(input) }) }
export function changePassword(currentPassword: string, newPassword: string) { return request<void>('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }) }
