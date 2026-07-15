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
export type Area = { id: number; displayName: string }
export type Plan = { id: number; name: string; pricePaise: number; units: string; isActive: number; subscriberCount: number }
export type Customer = { id: number; customerCode: string; name: string; phone: string | null; stbNumber: string | null; status: 'active' | 'inactive'; nextBillingStartDate: string | null; installationDate: string | null; areaId: number; planId: number | null; areaName: string; planName: string | null; amountDuePaise: number; creditBalancePaise: number; openInvoiceCount: number; oldestDuePeriodStart: string | null; latestDuePeriodEnd: string | null }
export type Invoice = { id: number; invoiceCode: string; customerId: number; customerName: string; periodStart: string; periodEnd: string; issuedDate: string; totalPayablePaise: number; balancePaise: number; status: string; dueDate: string; isMerged: number }
export type InvoiceDetail = Invoice & { customerCode: string; areaName: string; planName: string; stbNumber: string | null; monthsBilled: number; currentPeriodAmountPaise: number; previousDueSnapshotPaise: number; liveBalancePaise: number; charges: Array<{ chargeType: string; description: string; amountPaise: number }>; allocations: Array<{ paymentCode: string; paymentDate: string; cashPaise: number; discountPaise: number; creditPaise: number }>; mergeItems: Array<{ invoiceCode: string; planName: string; periodStart: string; periodEnd: string; amountPaise: number }> }
export type Payment = { id: number; paymentCode: string; customerId: number; customerName: string; paymentDate: string; amountReceivedPaise: number; discountGivenPaise: number; paymentMode: 'cash' | 'upi' | 'system_credit'; resultingStatus: string; notes?: string | null }
export type PaymentDetail = Payment & { customerCode: string; stbNumber: string | null; areaName: string; allocations: Array<{ invoiceCode: string; periodStart: string; periodEnd: string; cashPaise: number; discountPaise: number; creditPaise: number }> }
export type Expense = { id: number; description: string; amountPaise: number; expenseDate: string; category: string }
export type Report = { scope: ServiceType | 'all'; from: string; to: string; billedPaise: number; collectedPaise: number; todayCollectedPaise: number; outstandingPaise: number; activeSubscribers: number; expensePaise: number; netPaise: number; netLabel: string; dataQualityCount: number; payments: Payment[]; expenses: Expense[]; trends: Array<{ month: string; billedPaise: number; collectedPaise: number }> }
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

export function listCustomers(serviceType: ServiceType, query = '', includeDeleted = false) {
  return request<Customer[]>(`/api/customers?serviceType=${serviceType}&query=${encodeURIComponent(query)}${includeDeleted ? '&includeDeleted=1' : ''}`)
}
export function updateCustomer(serviceType: ServiceType, input: { id: number; name: string; areaId: number; phone?: string; stbNumber?: string; planId?: number; installationDate?: string; status: 'active' | 'inactive'; restartDate?: string }) { return request<void>('/api/customers', { method: 'PUT', body: JSON.stringify({ serviceType, ...input }) }) }
export function deleteCustomer(serviceType: ServiceType, id: number) { return request<void>(`/api/customers?serviceType=${serviceType}&id=${id}`, { method: 'DELETE' }) }

export function createCustomer(serviceType: ServiceType, input: { name: string; areaId: number; phone?: string; stbNumber?: string; planId?: number; installationDate?: string; openingBalancePaise: number; openingBalanceType: 'due' | 'advance' }) {
  return request<{ id: number; customerCode: string }>('/api/customers', { method: 'POST', body: JSON.stringify({ serviceType, ...input }) })
}

export function listInvoices(serviceType: ServiceType, query = '', showMerged = false) { return request<Invoice[]>(`/api/invoices?serviceType=${serviceType}&query=${encodeURIComponent(query)}${showMerged ? '&showMerged=1' : ''}`) }
export function getInvoice(serviceType: ServiceType, id: number) { return request<InvoiceDetail>(`/api/invoices?serviceType=${serviceType}&id=${id}`) }
export function createInvoice(serviceType: ServiceType, customerId: number, monthsBilled: number) { return request<{ invoiceCode: string; periodStart: string; periodEnd: string }>('/api/invoices', { method: 'POST', body: JSON.stringify({ serviceType, customerId, monthsBilled }) }) }
export function bulkCreateInvoices(serviceType: ServiceType, throughMonth: string, customerIds?: number[]) { return request<{ generated: Array<{ invoiceCode: string }>; skipped: number[] }>('/api/invoices/bulk', { method: 'POST', body: JSON.stringify({ serviceType, throughMonth, customerIds }) }) }
export function mergeInvoices(serviceType: ServiceType, invoiceIds: number[]) { return request<{ invoiceId: number; invoiceCode: string }>('/api/invoices/merge', { method: 'POST', body: JSON.stringify({ serviceType, invoiceIds }) }) }
export function listPayments(serviceType: ServiceType, filters: { query?: string; from?: string; to?: string; mode?: string } = {}) { const params = new URLSearchParams({ serviceType, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Record<string, string> }); return request<Payment[]>(`/api/payments?${params}`) }
export function getPayment(serviceType: ServiceType, id: number) { return request<PaymentDetail>(`/api/payments?serviceType=${serviceType}&id=${id}`) }
export function createPayment(serviceType: ServiceType, input: { customerId: number; paymentDate: string; amountReceivedPaise: number; discountGivenPaise: number; paymentMode: 'cash' | 'upi'; notes?: string }) { return request<{ paymentCode: string }>('/api/payments', { method: 'POST', body: JSON.stringify({ serviceType, ...input }) }) }
export function deleteInvoice(serviceType: ServiceType, invoiceId: number) { return request<void>(`/api/invoices?serviceType=${serviceType}&id=${invoiceId}`, { method: 'DELETE' }) }
export function deletePayment(serviceType: ServiceType, paymentId: number) { return request<void>(`/api/payments?serviceType=${serviceType}&id=${paymentId}`, { method: 'DELETE' }) }
export function listExpenses(filters: { from?: string; to?: string; category?: string } = {}) { const params = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Record<string, string>); return request<Expense[]>(`/api/expenses?${params}`) }
export function createExpense(input: { description: string; amountPaise: number; expenseDate: string; category: string }) { return request<{ id: number }>('/api/expenses', { method: 'POST', body: JSON.stringify(input) }) }
export function deleteExpense(id: number) { return request<void>(`/api/expenses?id=${id}`, { method: 'DELETE' }) }
export function getReport(serviceType: ServiceType | 'all', filters: { from?: string; to?: string; areaId?: string; paymentMode?: string } = {}) { const params = new URLSearchParams({ serviceType, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Record<string, string> }); return request<Report>(`/api/reports?${params}`) }
export function getSettings() { return request<BusinessSettings | null>('/api/settings') }
export function saveSettings(input: BusinessSettings) { return request<void>('/api/settings', { method: 'PUT', body: JSON.stringify(input) }) }
export function changePassword(currentPassword: string, newPassword: string) { return request<void>('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }) }
