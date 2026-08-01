import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, BarChart3, Bell, ChevronLeft, ChevronRight, CircleDollarSign, Command, DatabaseZap, FileText, HardDriveDownload, LayoutDashboard, LogOut, Menu, Moon, Package, Search, Settings, ShieldCheck, Sun, Users, Wallet, X } from 'lucide-react'
import { apiHealth, currentAdmin, listCustomers, login, logout } from './lib/api'
import type { Customer } from './lib/api'
import './App.css'
import './theme.css'

const CustomersPage = lazy(() => import('./pages/Management').then(({ CustomersPage }) => ({ default: CustomersPage })))
const PlansPage = lazy(() => import('./pages/Management').then(({ PlansPage }) => ({ default: PlansPage })))
const loadOperations = () => import('./pages/Operations')
const DashboardPage = lazy(() => loadOperations().then(({ DashboardPage }) => ({ default: DashboardPage })))
const ExpensesPage = lazy(() => loadOperations().then(({ ExpensesPage }) => ({ default: ExpensesPage })))
const InvoicesPage = lazy(() => loadOperations().then(({ InvoicesPage }) => ({ default: InvoicesPage })))
const PaymentsPage = lazy(() => loadOperations().then(({ PaymentsPage }) => ({ default: PaymentsPage })))
const RemindersPage = lazy(() => loadOperations().then(({ RemindersPage }) => ({ default: RemindersPage })))
const ReportsPage = lazy(() => loadOperations().then(({ ReportsPage }) => ({ default: ReportsPage })))
const SettingsPage = lazy(() => loadOperations().then(({ SettingsPage }) => ({ default: SettingsPage })))
const BackupPage = lazy(() => loadOperations().then(({ BackupPage }) => ({ default: BackupPage })))

type ServiceType = 'cable' | 'broadband'
const navigation = [['Dashboard', LayoutDashboard], ['Subscribers', Users], ['Invoices', FileText], ['Payments', Wallet], ['Reports', BarChart3], ['Expenses', CircleDollarSign], ['Reminders', Bell], ['Plans', Package], ['Settings', Settings], ['Manual Backup', HardDriveDownload]] as const
const navigationGroups = [{ label: 'Daily Work', items: navigation.slice(0, 5) }, { label: 'More', items: navigation.slice(5) }]
type Page = typeof navigation[number][0]
const pageLabels: Record<Page, string> = { Dashboard: 'Today', Subscribers: 'Customers', Invoices: 'Bills', Payments: 'Payments', Reports: 'Reports', Expenses: 'Expenses', Reminders: 'Reminders', Plans: 'Plans', Settings: 'Settings', 'Manual Backup': 'Backup' }
const pageSlugs = Object.fromEntries(navigation.map(([page]) => [page, page.toLowerCase().replace(' ', '-')])) as Record<Page, string>

function pageFromHash(): Page {
  const slug = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return navigation.find(([page]) => pageSlugs[page] === slug)?.[0] ?? 'Dashboard'
}

function serviceFromHash(): ServiceType { const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('service'); return value === 'broadband' || value === 'cable' ? value : localStorage.getItem('sitaram-service') === 'broadband' ? 'broadband' : 'cable' }
function pageHref(page: Page, service: ServiceType, params: Record<string, string> = {}) { return `#/${pageSlugs[page]}?${new URLSearchParams({ service, ...params })}` }
function preloadPage(page: Page) { return page === 'Subscribers' || page === 'Plans' ? import('./pages/Management') : loadOperations() }

function App() {
  const [username, setUsername] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [service, setService] = useState<ServiceType>(serviceFromHash)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sitaram-sidebar') === 'collapsed')
  const [commandOpen, setCommandOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('sitaram-theme') === 'dark' ? 'dark' : 'light')
  const [page, setPage] = useState<Page>(pageFromHash)
  const [routeHash, setRouteHash] = useState(window.location.hash)
  const [dbState, setDbState] = useState<{ status: 'ok' | 'unavailable'; storage: 'local' | 'cloud' | 'unknown' }>({ status: 'unavailable', storage: 'unknown' })
  const sidebar = useRef<HTMLElement>(null)

  useEffect(() => {
    void preloadPage(pageFromHash())
    currentAdmin().then((admin) => setUsername(admin.username)).catch(() => setUsername(null)).finally(() => setAuthLoading(false))
    apiHealth().then(setDbState)
  }, [])
  useEffect(() => { const syncPage = () => { setPage(pageFromHash()); setService(serviceFromHash()); setRouteHash(window.location.hash) }; window.addEventListener('hashchange', syncPage); return () => window.removeEventListener('hashchange', syncPage) }, [])
  useEffect(() => { document.getElementById('main-content')?.focus() }, [page])
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f1420' : '#f1f3f7'); localStorage.setItem('sitaram-theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('sitaram-service', service); if (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('service') !== service) history.replaceState(null, '', pageHref(page, service)) }, [page, service])
  useEffect(() => { const unauthorized = () => setUsername(null); window.addEventListener('sitaram:unauthorized', unauthorized); return () => window.removeEventListener('sitaram:unauthorized', unauthorized) }, [])
  useEffect(() => { localStorage.setItem('sitaram-sidebar', sidebarCollapsed ? 'collapsed' : 'expanded') }, [sidebarCollapsed])
  useEffect(() => {
    if (!menuOpen) return
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => [...(sidebar.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])]
    const items = focusable()
    ;(items.find((item) => item.classList.contains('nav-item')) ?? items[0])?.focus()
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const currentItems = focusable()
      const first = currentItems[0]
      const last = currentItems.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', trapFocus)
    return () => { document.removeEventListener('keydown', trapFocus); previous?.focus() }
  }, [menuOpen])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('[aria-modal="true"]')) setCommandOpen((open) => !open) }
      if (event.key === 'Escape') { setCommandOpen(false); setMenuOpen(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const navigateTo = (nextPage: Page, params: Record<string, string> = {}) => { setPage(nextPage); setMenuOpen(false); window.location.hash = pageHref(nextPage, service, params).slice(1) }
  const signOut = () => void logout().finally(() => setUsername(null))
  if (authLoading) return <LoadingWorkspace />
  if (!username) return <LoginScreen onSuccess={setUsername} />
  const serviceName = service === 'cable' ? 'Cable' : 'Broadband'
  const connected = dbState.status === 'ok'

  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    {menuOpen ? <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
    <aside ref={sidebar} className={menuOpen ? 'sidebar sidebar-open' : 'sidebar'}>
      <div className="sidebar-header">
        <div className="brand"><span className="brand-logo"><img src="/logo.png" width="32" height="32" alt="Sitaram Cable & Broadband" /></span><span className="brand-copy">SITARAM <small>Cable & Broadband</small></span></div>
        <button className="service-mode" aria-label={`Switch to ${service === 'cable' ? 'Broadband' : 'Cable'} mode`} onClick={() => { const next = service === 'cable' ? 'broadband' : 'cable'; setService(next); history.replaceState(null, '', pageHref(page, next)) }} title={`${serviceName} workspace`}><span><i className={service} /> <b>{serviceName.toUpperCase()}</b></span><ArrowRightLeft size={14} aria-hidden="true" /></button>
      </div>
      <nav aria-label="Primary navigation">{navigationGroups.map((group) => <section className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map(([label, Icon]) => <a className={page === label ? 'nav-item active' : 'nav-item'} aria-current={page === label ? 'page' : undefined} title={sidebarCollapsed ? pageLabels[label] : undefined} href={pageHref(label, service)} key={label} onPointerEnter={() => void preloadPage(label)} onFocus={() => void preloadPage(label)} onClick={() => setMenuOpen(false)}><Icon size={18} aria-hidden="true" /><span>{pageLabels[label]}</span></a>)}</section>)}</nav>
      <div className={`database-state ${dbState.status}`} title={connected ? `${dbState.storage} database connected` : 'Database connection unavailable'}><span className="database-dot" /><span><strong>{serviceName.toUpperCase()} DB</strong><small>{connected ? (dbState.storage === 'cloud' ? 'Securely synced' : 'Local storage connected') : 'Connection unavailable'}</small></span><DatabaseZap size={15} aria-hidden="true" /></div>
    </aside>

    <main id="main-content" tabIndex={-1}>
      <header className="app-topbar">
        <div className="topbar-start"><button className="sidebar-trigger desktop-only" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</button><button className="sidebar-trigger mobile-only" onClick={() => setMenuOpen(true)} aria-label="Open navigation" aria-expanded={menuOpen}><Menu size={19} /></button><div className="breadcrumbs"><span>{serviceName} Workspace</span><i>/</i><strong>{pageLabels[page]}</strong></div></div>
        <div className="topbar-actions"><button className="command-trigger" onClick={() => { if (!document.querySelector('[aria-modal="true"]')) setCommandOpen(true) }}><Search size={15} aria-hidden="true" /><span>Find customer or page…</span><kbd>Ctrl K</kbd></button><span className={`connection-pill ${connected ? 'connected' : ''}`}><i />{connected ? 'Connected' : 'Offline'}</span><button className="topbar-icon" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button><button className="user-chip" onClick={signOut} aria-label={`Sign out ${username}`}><span>{username.slice(0, 1).toUpperCase()}</span><span><strong>{username}</strong><small>Administrator</small></span><LogOut size={15} /></button></div>
      </header>
      <Suspense fallback={<PageLoadingSkeleton />}><div className="workspace-content">{page === 'Dashboard' ? <DashboardPage serviceType={service} onNavigate={navigateTo} /> : page === 'Plans' ? <PlansPage serviceType={service} /> : page === 'Subscribers' ? <CustomersPage key={`${service}:${routeHash}`} serviceType={service} initialQuery={new URLSearchParams(routeHash.split('?')[1] ?? '').get('query') ?? ''} initialAction={new URLSearchParams(routeHash.split('?')[1] ?? '').get('action') ?? ''} /> : page === 'Invoices' ? <InvoicesPage serviceType={service} /> : page === 'Payments' ? <PaymentsPage serviceType={service} /> : page === 'Reports' ? <ReportsPage serviceType={service} /> : page === 'Expenses' ? <ExpensesPage /> : page === 'Reminders' ? <RemindersPage serviceType={service} /> : page === 'Manual Backup' ? <BackupPage /> : <SettingsPage />}</div></Suspense>
    </main>
    {commandOpen ? <CommandPalette page={page} serviceType={service} onNavigate={(nextPage) => { navigateTo(nextPage); setCommandOpen(false) }} onOpenCustomer={(customer) => { navigateTo('Subscribers', { query: customer.customerCode, action: 'view' }); setCommandOpen(false) }} onClose={() => setCommandOpen(false)} /> : null}
  </div>
}

function CommandPalette({ page, serviceType, onNavigate, onOpenCustomer, onClose }: { page: Page; serviceType: ServiceType; onNavigate: (page: Page) => void; onOpenCustomer: (customer: Customer) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [customerLoading, setCustomerLoading] = useState(false)
  const dialog = useRef<HTMLElement>(null); const input = useRef<HTMLInputElement>(null)
  const results = useMemo(() => navigation.filter(([label]) => `${label} ${pageLabels[label]}`.toLowerCase().includes(query.trim().toLowerCase())), [query])
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; input.current?.focus(); return () => previous?.focus() }, [])
  useEffect(() => {
    const value = query.trim()
    if (value.length < 2) { setCustomers([]); setCustomerLoading(false); return }
    setCustomerLoading(true)
    let cancelled = false
    const timer = window.setTimeout(() => {
      listCustomers(serviceType, value, false, { limit: 8 })
        .then((result) => { if (!cancelled) setCustomers(result.items) })
        .catch(() => { if (!cancelled) setCustomers([]) })
        .finally(() => { if (!cancelled) setCustomerLoading(false) })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query, serviceType])
  function handleKey(event: React.KeyboardEvent) { if (event.key === 'Escape') return onClose(); if (event.key !== 'Tab') return; const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])') ?? [])].filter((item) => !item.hasAttribute('disabled')); const first = items[0]; const last = items.at(-1); if (!first || !last) return; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } }
  return createPortal(<div className="command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialog} className="command-dialog" role="dialog" aria-modal="true" aria-labelledby="command-title" onKeyDown={handleKey}><div className="command-search"><Search size={19} aria-hidden="true" /><label className="sr-only" htmlFor="command-input" id="command-title">Find a customer or workspace page</label><input ref={input} id="command-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, code, phone, STB, area, or page…" autoComplete="off" /><button type="button" onClick={onClose} aria-label="Close finder"><X size={17} aria-hidden="true" /></button></div><div className="command-results">{query.trim().length >= 2 ? <><p>Customers</p>{customerLoading ? <div className="command-empty" role="status"><span>Searching customers…</span></div> : customers.map((customer) => <button key={customer.id} onClick={() => onOpenCustomer(customer)}><span><Users size={17} aria-hidden="true" /><span><strong>{customer.name}</strong><small>{customer.customerCode} · {customer.phone || customer.stbNumber || customer.areaName}</small></span></span><kbd>Open</kbd></button>)}{!customerLoading && customers.length === 0 ? <div className="command-empty"><span>No matching customers</span></div> : null}</> : null}<p>Pages</p>{results.map(([label, Icon]) => <button className={page === label ? 'selected' : ''} key={label} onClick={() => onNavigate(label)}><span><Icon size={17} aria-hidden="true" /><span><strong>{pageLabels[label]}</strong><small>Open {pageLabels[label].toLowerCase()}</small></span></span><kbd>Enter</kbd></button>)}</div><footer><span><kbd>Tab</kbd> Navigate</span><span><kbd>Esc</kbd> Close</span></footer></section></div>, document.body)
}

function LoadingWorkspace() { return <div className="loading-screen" role="status" aria-live="polite"><div className="loading-brand"><span className="brand-logo"><img src="/logo.png" width="32" height="32" alt="" /></span><span><strong>Preparing workspace</strong><small>Loading secure billing data…</small></span></div><div className="loading-track" aria-hidden="true"><i /></div></div> }
function PageLoadingSkeleton() { return <div className="page-loading" role="status" aria-label="Loading page"><span className="skeleton-line skeleton-title" /><span className="skeleton-line skeleton-copy" /><span className="skeleton-panel" /></div> }

function LoginScreen({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [showPassword, setShowPassword] = useState(false); const [error, setError] = useState(''); const [submitting, setSubmitting] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setSubmitting(true); setError(''); try { const admin = await login(username, password); onSuccess(admin.username) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign in.') } finally { setSubmitting(false) } }
  return <main className="login-page"><section className="login-shell"><aside className="login-aside"><div className="brand"><span className="brand-logo login-logo"><img src="/logo.png" width="52" height="52" alt="Sitaram Cable & Broadband" /></span><span>SITARAM <small>Cable & Broadband</small></span></div><div><span className="login-kicker">Operations Console</span><h1>Billing clarity.<br />Every rupee traced.</h1><p>One secure workspace for cable and broadband subscribers, billing, collections, and audit-ready reports.</p></div><div className="login-trust"><span><ShieldCheck size={17} />Server-side security</span><span><DatabaseZap size={17} />Protected financial ledger</span></div></aside><section className="login-card"><div className="login-card-heading"><span className="login-icon"><Command size={20} /></span><div><p className="eyebrow">Administrator access</p><h2>Welcome back</h2></div></div><p className="login-copy">Enter your credentials to continue to the operations workspace.</p><form onSubmit={submit}><label>Username<input name="username" autoComplete="username" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label>Password<span className="password-field"><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><button type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? 'Hide' : 'Show'}</button></span></label>{error ? <p className="form-error" role="alert">{error}</p> : null}<button className="primary login-button" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in securely'}</button></form><p className="login-help"><ShieldCheck size={13} /> Authorized business administrator only</p></section></section></main>
}

export default App
