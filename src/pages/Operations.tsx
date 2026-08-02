import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Banknote,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  CreditCard,
  Download,
  Eye,
  FilePlus2,
  FileText,
  HardDriveDownload,
  IndianRupee,
  MessageCircle,
  Merge,
  ReceiptText,
  Search,
  Settings2,
  Share2,
  TrendingUp,
  Trash2,
  UserPlus,
  Users,
  WalletCards,
} from "lucide-react";
import { Modal } from "../components/Modal";
import {
  bulkCreateInvoices,
  changePassword,
  createExpense,
  createPayment,
  deleteExpense,
  deleteInvoice,
  deletePayment,
  getCompleteReport,
  getInvoice,
  getInvoiceDeletePreview,
  getPayment,
  getPaymentDeletePreview,
  getReport,
  getSettings,
  listAreas,
  listAllInvoices,
  listAllPayments,
  listAuditEvents,
  listCustomers,
  listExpenses,
  listInvoices,
  listPayments,
  mergeInvoices,
  saveSettings,
} from "../lib/api";
import type {
  BusinessSettings,
  Customer,
  Expense,
  Invoice,
  InvoiceDeletePreview,
  InvoiceDetail,
  Payment,
  PaymentDeletePreview,
  PaymentDetail,
  AuditEvent,
  BulkInvoiceResult,
  Report,
  ServiceType,
} from "../lib/api";
import {
  addBillingDays,
  billingCyclePosition,
  endOfCalendarMonth,
  formatBusinessDate,
  todayInBusinessTimezone,
} from "../lib/date";
import {
  formatRupees,
  rupeesToPaise,
} from "../lib/money";
import { useDebouncedValue } from "../lib/hooks";
import { InvoiceForm } from "../components/InvoiceForm";
import { PaymentAmountFields } from "../components/PaymentAmountFields";
import { downloadCsv } from "../lib/csv";

type Notice = { kind: "success" | "error"; message: string } | undefined;
function currentMonthRange() {
  const today = todayInBusinessTimezone();
  return {
    from: `${today.slice(0, 7)}-01`,
    to: endOfCalendarMonth(today.slice(0, 7)),
    areaId: "",
  };
}
const documents = () => import("../lib/documents");
const BACKUP_STORAGE_KEY = "sitaram:last-backup-at";
function markBackupDownloaded() { window.localStorage.setItem(BACKUP_STORAGE_KEY, new Date().toISOString()); }
function lastBackupLabel(value: string | null) { return value ? `Last downloaded ${new Date(value).toLocaleString()}` : "No backup downloaded from this browser yet"; }

export function DashboardPage({
  serviceType,
  onNavigate,
  onOpenSearch,
}: {
  serviceType: ServiceType;
  onNavigate: (
    page: "Subscribers" | "Invoices" | "Payments" | "Reports" | "Reminders",
    params?: Record<string, string>,
  ) => void;
  onOpenSearch: () => void;
}) {
  const [report, setReport] = useState<Report>();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [areas, setAreas] = useState<
    Array<{ id: number; displayName: string }>
  >([]);
  const [error, setError] = useState("");
  const [range, setRange] = useState(currentMonthRange);
  useEffect(() => {
    setRange((current) => ({ ...current, areaId: "" }));
  }, [serviceType]);
  useEffect(() => {
    setReport(undefined);
    setError("");
    Promise.all([getReport(serviceType, range), listAreas(serviceType), listCustomers(serviceType, "", false, { limit: 500 })])
      .then(([nextReport, nextAreas, nextCustomers]) => {
        setReport(nextReport);
        setAreas(nextAreas);
        setCustomers(nextCustomers.items);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [range, serviceType]);
  const today = todayInBusinessTimezone();
  const scopedCustomers = range.areaId ? customers.filter((customer) => customer.areaId === Number(range.areaId)) : customers;
  const rechargeDueCount = scopedCustomers.filter((customer) => customer.serviceStatus === "recharge_due").length;
  const paymentDueCount = scopedCustomers.filter((customer) => customer.amountDuePaise - customer.creditBalancePaise > 0).length;
  const setupCount = scopedCustomers.filter((customer) => !customer.planId || !customer.planIsActive || !customer.installationDate || !customer.nextBillingStartDate).length;
  const attentionItems = scopedCustomers.flatMap((customer) => {
    if (!customer.planId || !customer.planIsActive || !customer.installationDate || !customer.nextBillingStartDate) return [{ customer, action: "setup", actionLabel: "Complete Setup", reason: !customer.planId ? "Plan missing" : !customer.installationDate ? "Installation date missing" : "Billing setup incomplete", priority: 1 }];
    if (customer.serviceStatus === "recharge_due") return [{ customer, action: "recharge", actionLabel: "Recharge", reason: customer.latestPeriodEnd ? `Service inactive since ${formatBusinessDate(addBillingDays(customer.latestPeriodEnd, 1))}` : "Service not started", priority: 2 }];
    const balance = customer.amountDuePaise - customer.creditBalancePaise;
    if (balance > 0) return [{ customer, action: "payment", actionLabel: "Record Payment", reason: `${formatRupees(balance)} unpaid`, priority: 3 }];
    if (customer.latestPeriodEnd && customer.latestPeriodEnd <= addBillingDays(today, 3)) return [{ customer, action: "recharge", actionLabel: "Add Recharge", reason: `Active until ${formatBusinessDate(customer.latestPeriodEnd)}`, priority: 4 }];
    return [];
  }).sort((left, right) => left.priority - right.priority || left.customer.name.localeCompare(right.customer.name)).slice(0, 12);
  if (error) return <ErrorNotice message={error} />;
  if (!report) return <Loading label="Loading dashboard…" />;
  return (
    <section className="page-content dashboard-page">
      <h1 className="sr-only">Today</h1>
      <section className="dashboard-toolbar">
        <div>
          <p className="eyebrow">Good morning, Admin</p>
          <button className="mobile-dashboard-alert" aria-label="Open reminders" onClick={() => onNavigate("Reminders")}><Bell size={20} aria-hidden="true" /></button>
          <h2>Today</h2>
          <p className="dashboard-period">{formatBusinessDate(range.from)} → {formatBusinessDate(range.to)}</p>
          <div className="dashboard-context" aria-label="Workspace status">
            <span><strong>{report.activeSubscribers}</strong> services active today</span>
            <span className={report.dataQualityCount ? "needs-attention" : "ready"}>
              {report.dataQualityCount
                ? `${report.dataQualityCount} need billing setup`
                : "Billing setup complete"}
            </span>
          </div>
          <button className="dashboard-subscriber-search" onClick={onOpenSearch}>
            <Search size={18} aria-hidden="true" />
            <span>Find subscriber, phone or STB</span>
          </button>
        </div>
        <details className="dashboard-filters" open>
          <summary>Period &amp; area</summary>
          <div className="dashboard-range">
          <label>
            From
            <input
              name="dashboardFrom"
              type="date"
              max={range.to}
              value={range.from}
              onChange={(event) =>
                setRange((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
            />
          </label>
          <label>
            To
            <input
              name="dashboardTo"
              type="date"
              min={range.from}
              value={range.to}
              onChange={(event) =>
                setRange((current) => ({ ...current, to: event.target.value }))
              }
            />
          </label>
          <label>
            Area
            <select
              name="dashboardArea"
              value={range.areaId}
              onChange={(event) =>
                setRange((current) => ({
                  ...current,
                  areaId: event.target.value,
                }))
              }
            >
              <option value="">All areas</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.displayName}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={() => onNavigate("Invoices")}>
            <FilePlus2 size={17} aria-hidden="true" /> Add Recharge
          </button>
          </div>
        </details>
      </section>
      <section className="panel today-action-centre" aria-labelledby="today-work-title">
        <div className="panel-heading today-action-heading"><div><p className="eyebrow">Start here</p><h2 id="today-work-title">Work to Do</h2><small>Each customer shows the most important next action.</small></div><div className="attention-counts" aria-label="Work counts"><span><CircleAlert size={18} aria-hidden="true" /><strong>{paymentDueCount}</strong><small>Payments Due</small></span><span><Clock3 size={18} aria-hidden="true" /><strong>{rechargeDueCount}</strong><small>Recharge Due</small></span><span><Settings2 size={18} aria-hidden="true" /><strong>{setupCount}</strong><small>Setup Needed</small></span></div></div>
        {attentionItems.length ? <div className="attention-list" role="list">{attentionItems.map(({ customer, action, actionLabel, reason }) => <div role="listitem" key={customer.id}><span className="attention-customer"><strong>{customer.name}</strong><small>{customer.customerCode} · {customer.planName || customer.areaName}</small></span><span className={`attention-state ${action}`}>{reason}</span><button className={action === "recharge" ? "primary" : "secondary"} onClick={() => onNavigate("Subscribers", { query: customer.customerCode, action })}>{actionLabel}</button></div>)}</div> : <div className="today-clear"><CheckCircle2 size={22} aria-hidden="true" /><span><strong>Daily work is clear</strong><small>No recharge, payment, or setup action is waiting.</small></span></div>}
        {scopedCustomers.length > attentionItems.length && attentionItems.length >= 12 ? <button className="text-button today-view-all" onClick={() => onNavigate("Subscribers")}>View all customers</button> : null}
      </section>
      <section className="metrics dashboard-metrics" aria-label="Business statistics">
        <Metric
          icon={<TrendingUp />}
          tone="orange"
          label="Today’s collection"
          value={formatRupees(report.todayCollectedPaise)}
          hint="Cash & UPI received today"
        />
        <Metric
          icon={<WalletCards />}
          tone="green"
          label="Collected in range"
          value={formatRupees(report.collectedPaise)}
          hint={`${formatBusinessDate(range.from)} – ${formatBusinessDate(range.to)}`}
        />
        <Metric
          icon={<FileText />}
          tone="blue"
          label="Billed in range"
          value={formatRupees(report.billedPaise)}
          hint="Current-period charges issued"
        />
        <Metric
          icon={<Banknote />}
          tone="yellow"
          label="Pending dues"
          value={formatRupees(report.outstandingPaise)}
          hint="Action required"
        />
      </section>
      <section className="quick-actions" aria-label="Quick actions">
        <button onClick={() => onNavigate("Invoices")}>
          <span>
            <IndianRupee />
          </span>
          <strong>Recharge</strong>
          <small>Add a service recharge</small>
        </button>
        <button onClick={() => onNavigate("Payments")}>
          <span>
            <CreditCard />
          </span>
          <strong>Record payment</strong>
          <small>Record a collection</small>
        </button>
        <button onClick={() => onNavigate("Subscribers", { action: "add" })}>
          <span>
            <UserPlus />
          </span>
          <strong>Add subscriber</strong>
          <small>Create a subscriber record</small>
        </button>
        <button onClick={() => onNavigate("Reports")}>
          <span>
            <CalendarDays />
          </span>
          <strong>Reports</strong>
          <small>Review ledgers & trends</small>
        </button>
      </section>
      <section className="mobile-recent-subscribers" aria-labelledby="recent-subscribers-title">
        <header><h2 id="recent-subscribers-title">Recent subscribers</h2><button className="text-button" onClick={() => onNavigate("Subscribers")}>View all</button></header>
        <div>
          {scopedCustomers.slice(0, 5).map((customer) => {
            const balance = customer.amountDuePaise - customer.creditBalancePaise;
            return <button key={customer.id} onClick={() => onNavigate("Subscribers", { query: customer.customerCode, action: "view" })}>
              <i className="avatar" aria-hidden="true">{customer.name.slice(0, 1).toUpperCase()}</i>
              <span><strong>{customer.name}</strong><small>{customer.customerCode}{customer.phone ? ` · ${customer.phone}` : ""}</small><small>{customer.areaName} · {customer.planName || "Plan missing"}</small></span>
              <span className="recent-subscriber-state"><strong className={balance > 0 ? "amount-due" : balance < 0 ? "amount-credit" : ""}>{formatRupees(Math.abs(balance))}{balance > 0 ? " due" : ""}</strong><small className={`mobile-status-pill ${balance > 0 ? "due" : customer.status}`}>{balance > 0 ? "Due" : customer.status === "active" ? "Active" : "Inactive"}</small></span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>;
          })}
        </div>
      </section>
      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">12-month trend</p>
              <h2>Collected vs. billed</h2>
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("Reports")}
            >
              Open reports
            </button>
          </div>
          <TrendChart trends={report.trends} />
        </article>
        <article className="panel table-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Latest activity</p>
              <h2>Recent payments</h2>
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("Payments")}
            >
              Record payment
            </button>
          </div>
          <PaymentMiniList payments={report.payments.slice(0, 6)} />
        </article>
        <article className="panel table-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Next 3 days</p>
              <h2>Expiring soon</h2>
            </div>
            <span>{report.expiringSoon.length}</span>
          </div>
          {report.expiringSoon.length ? (
            <div className="activity-list">
              {report.expiringSoon.map((customer) => (
                <div key={customer.id}>
                  <span>
                    <strong>{customer.name}</strong>
                    <small>
                      {customer.customerCode} · expires{" "}
                      {formatBusinessDate(customer.periodEnd)}
                    </small>
                  </span>
                  <b>{customer.phone || "No phone"}</b>
                </div>
              ))}
            </div>
          ) : (
            <Empty message="No service expires in the next three days" />
          )}
        </article>
        <article className="panel table-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Collection channels</p>
              <h2>Cash and UPI</h2>
            </div>
          </div>
          <div className="detail-grid">
            <Detail
              label="Cash received"
              value={formatRupees(report.cashCollectedPaise)}
            />
            <Detail
              label="UPI received"
              value={formatRupees(report.upiCollectedPaise)}
            />
            {report.areaBreakdown.slice(0, 4).map((area) => (
              <Detail
                key={area.areaName}
                label={area.areaName}
                value={`${area.subscriberCount} active subscriber(s)`}
              />
            ))}
          </div>
        </article>
      </section>
    </section>
  );
}

export function InvoicesPage({ serviceType }: { serviceType: ServiceType }) {
  const today = todayInBusinessTimezone();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [areas, setAreas] = useState<
    Array<{ id: number; displayName: string }>
  >([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [settings, setSettings] = useState<BusinessSettings>();
  const [detail, setDetail] = useState<InvoiceDetail>();
  const [pdfPreview, setPdfPreview] = useState<{ title: string; url: string }>();
  const [query, setQuery] = useState("");
  const [showMerged, setShowMerged] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [billingDialog, setBillingDialog] = useState<"single" | "bulk" | "due">();
  const [invoiceTotal, setInvoiceTotal] = useState(0);
  const [invoiceOffset, setInvoiceOffset] = useState(0);
  const [bulkSelection, setBulkSelection] = useState<number[]>([]);
  const [bulkThroughMonth, setBulkThroughMonth] = useState(today.slice(0, 7));
  const [bulkPreview, setBulkPreview] = useState<BulkInvoiceResult>();
  const [confirming, setConfirming] = useState<Invoice | "merge">();
  const [deleteReason, setDeleteReason] = useState("");
  const [deletePreview, setDeletePreview] = useState<InvoiceDeletePreview>();
  const [filters, setFilters] = useState({
    status: "",
    billingMode: "",
    areaId: "",
    from: "",
    to: "",
  });
  const deferredQuery = useDebouncedValue(query, 300);
  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      listCustomers(serviceType, '', false, { limit: 500 }),
      listAreas(serviceType),
      listInvoices(
        serviceType,
        deferredQuery,
        showMerged,
        invoiceOffset,
        filters,
      ),
      getSettings(),
    ])
      .then(([nextCustomers, nextAreas, nextInvoices, nextSettings]) => {
        setCustomers(nextCustomers.items);
        setAreas(nextAreas);
        setInvoices(nextInvoices.items);
        setInvoiceTotal(nextInvoices.total);
        setSettings(nextSettings ?? undefined);
      })
      .catch((error: Error) =>
        setNotice({ kind: "error", message: error.message }),
      )
      .finally(() => setLoading(false));
  }, [deferredQuery, filters, invoiceOffset, serviceType, showMerged]);
  useEffect(() => {
    setInvoiceOffset(0);
  }, [deferredQuery, filters, serviceType, showMerged]);
  useEffect(() => {
    setSelected([]);
    refresh();
  }, [refresh]);
  const billable = customers.filter(
    (customer) =>
      customer.status === "active" &&
      customer.planIsActive &&
      customer.installationDate &&
      customer.nextBillingStartDate,
  );
  const dueBillable = billable.filter(
    (customer) => customer.nextBillingStartDate! <= today,
  );

  async function submitBulk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bulkSelection.length) return setNotice({ kind: "error", message: "Select at least one customer to review." });
    setSubmitting(true);
    try {
      if (!bulkPreview) {
        const preview = await bulkCreateInvoices(serviceType, bulkThroughMonth, bulkSelection, true);
        setBulkPreview(preview);
        return;
      }
      const result = await bulkCreateInvoices(
        serviceType,
        bulkThroughMonth,
        bulkSelection,
      );
      setBillingDialog(undefined);
      setBulkSelection([]);
      setBulkPreview(undefined);
      const failedSummary = result.failed.slice(0, 3).map((item) =>
        `${item.customerName ?? `Subscriber ${item.customerId}`}${item.customerCode ? ` (${item.customerCode})` : ""}: ${item.reason}`,
      ).join(" ");
      setNotice({
        kind: result.failed.length ? "error" : "success",
        message: result.failed.length
          ? `${result.generated.length} bill(s) created. ${result.failed.length} customer(s) were not billed. ${failedSummary}${result.failed.length > 3 ? ` ${result.failed.length - 3} more need review.` : ""}`
          : `${result.generated.length} bill(s) created. ${result.skipped.length} customer(s) had no complete 30-day period to bill.`,
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Bulk billing failed.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function remove(invoice: Invoice) {
    setSubmitting(true);
    try {
      await deleteInvoice(serviceType, invoice.id, deleteReason);
      setConfirming(undefined);
      setDeleteReason("");
      setNotice({
        kind: "success",
        message: invoice.isCombined
          ? `${invoice.invoiceCode} deleted; original invoices were restored and the ledger was rebuilt.`
          : `${invoice.invoiceCode} deleted; its linked payments and billing position were safely rebuilt.`,
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to delete invoice.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function exportInvoices() {
    setSubmitting(true);
    try {
      const exported = await listAllInvoices(
        serviceType,
        deferredQuery,
        showMerged,
        filters,
      );
      downloadCsv(
        `${serviceType}-invoices.csv`,
        exported.map((invoice) => ({
          Invoice: invoice.invoiceCode,
          Customer: invoice.customerName,
          Issued: invoice.issuedDate,
          Due: invoice.dueDate,
          "Service Start": invoice.periodStart,
          "Service Expiry": invoice.periodEnd,
          "Cycle Position": billingCyclePosition(invoice.periodStart, invoice.periodEnd),
          Type: invoice.billingMode,
          Status: invoice.status,
          "Current Plan Charge": (invoice.currentPeriodAmountPaise / 100).toFixed(2),
          "Previous Due At Issue": (invoice.previousDueSnapshotPaise / 100).toFixed(2),
          "Total Payable At Issue": (invoice.totalPayablePaise / 100).toFixed(2),
          "Live Invoice Balance": (invoice.balancePaise / 100).toFixed(2),
        })),
      );
      setNotice({
        kind: "success",
        message: `${exported.length} matching invoice(s) exported.`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to export invoices.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function mergeSelected() {
    setSubmitting(true);
    try {
      const result = await mergeInvoices(serviceType, selected);
      setConfirming(undefined);
      setSelected([]);
      setNotice({
        kind: "success",
        message: `${result.invoiceCode} created from selected invoices.`,
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to merge invoices.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function openDetail(invoice: Invoice) {
    try {
      setDetail(await getInvoice(serviceType, invoice.id));
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to load invoice.",
      });
    }
  }
  async function confirmDelete(invoice: Invoice) {
    setDeleteReason("");
    setDeletePreview(undefined);
    setConfirming(invoice);
    try {
      setDeletePreview(await getInvoiceDeletePreview(serviceType, invoice.id));
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to preview deletion.",
      });
      setConfirming(undefined);
    }
  }

  return (
    <section className="page-content">
      <PageTitle
        title="Bills"
        subtitle="Add recharges, review service dates, and track what customers owe."
        action={
          <div className="page-actions invoice-page-actions">
            <button
              className="secondary"
              disabled={submitting}
              onClick={() => void exportInvoices()}
            >
              <Download size={16} /> Export
            </button>
            <button
              className="secondary"
              onClick={() => {
                setBulkSelection([]);
                setBulkPreview(undefined);
                setBulkThroughMonth(today.slice(0, 7));
                setBillingDialog("bulk");
              }}
            >
              <Users size={16} /> Recharge Many
            </button>
            <button
              className="primary"
              disabled={!dueBillable.length || submitting}
              title={
                dueBillable.length
                  ? "Review complete recharge periods due today or earlier"
                  : "No customers are due for recharge"
              }
              onClick={() => {
                setBulkSelection(dueBillable.map((customer) => customer.id));
                setBulkPreview(undefined);
                setBulkThroughMonth(today.slice(0, 7));
                setBillingDialog("due");
              }}
            >
              <CalendarDays size={16} /> Review Due Recharges
            </button>
            <button
              className="secondary"
              onClick={() => setBillingDialog("single")}
            >
              <FilePlus2 size={16} /> Add Recharge
            </button>
          </div>
        }
      />
      {notice && <NoticeMessage notice={notice} />}
      <article className="panel table-panel responsive-register invoice-register">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{serviceType} billing</p>
            <h2>Bill History</h2>
          </div>
          {selected.length >= 2 && (
            <button
              className="secondary"
              disabled={submitting}
              onClick={() => setConfirming("merge")}
            >
              <Merge size={16} aria-hidden="true" /> Merge {selected.length}
            </button>
          )}
        </div>
        <div className="filter-row">
          <div className="search-row">
            <Search size={18} aria-hidden="true" />
            <input
              name="invoiceSearch"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search bill, customer, ID, or STB…"
              aria-label="Search bills"
            />
          </div>
          <label className="check-row">
            <input
              name="showMergedInvoices"
              type="checkbox"
              checked={showMerged}
              onChange={(event) => setShowMerged(event.target.checked)}
            />{" "}
            Show merged-away records
          </label>
        </div>
        <div className="filter-grid">
          <label>
            Status
            <select
              name="invoiceStatus"
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value,
                }))
              }
            >
              <option value="">All</option>
              <option value="unpaid">Unpaid</option>
              <option value="partial">Partially paid</option>
              <option value="paid">Paid</option>
            </select>
          </label>
          <label>
            Bill Type
            <select
              name="invoiceBillingMode"
              value={filters.billingMode}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  billingMode: event.target.value,
                }))
              }
            >
              <option value="">All</option>
              <option value="normal">Service recharge</option>
              <option value="historical">Older missed bill</option>
            </select>
          </label>
          <label>
            Area
            <select
              name="invoiceArea"
              value={filters.areaId}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  areaId: event.target.value,
                }))
              }
            >
              <option value="">All</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Service from
            <input
              name="invoiceFrom"
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Service to
            <input
              name="invoiceTo"
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  to: event.target.value,
                }))
              }
            />
          </label>
        </div>
        {loading ? (
          <p className="empty-inline" role="status">
            Loading bills…
          </p>
        ) : invoices.length ? (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <span className="sr-only">Select</span>
                    </th>
                    <th>Bill</th>
                    <th>Customer</th>
                    <th>Period</th>
                    <th>Balance</th>
                    <th>Status</th>
                    <th className="row-actions-column">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr
                      key={invoice.id}
                      className={invoice.isMerged ? "muted-row" : ""}
                    >
                      <td data-label="Select">
                        {invoice.status === "unpaid" && !invoice.isMerged ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${invoice.invoiceCode}`}
                            checked={selected.includes(invoice.id)}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, invoice.id]
                                  : current.filter((id) => id !== invoice.id),
                              )
                            }
                          />
                        ) : null}
                      </td>
                      <td data-label="Bill">
                        <strong>{invoice.invoiceCode}</strong>
                        <small>
                          Issued {formatBusinessDate(invoice.issuedDate)} · Due{" "}
                          {formatBusinessDate(invoice.dueDate)}
                        </small>
                      </td>
                      <td data-label="Customer">{invoice.customerName}</td>
                      <td data-label="Period">
                        {formatBusinessDate(invoice.periodStart)}
                        <small>
                          to {formatBusinessDate(invoice.periodEnd)}
                        </small>
                        <small>{billingCyclePosition(invoice.periodStart, invoice.periodEnd)}</small>
                      </td>
                      <td data-label="Balance">
                        <strong
                          className={
                            invoice.balancePaise > 0 ? "amount-due" : ""
                          }
                        >
                          {formatRupees(invoice.balancePaise)}
                        </strong>
                        <small>Current {formatRupees(invoice.currentPeriodAmountPaise)} · Previous at issue {formatRupees(invoice.previousDueSnapshotPaise)}</small>
                        <small>
                          Total at issue {formatRupees(invoice.totalPayablePaise)}
                        </small>
                      </td>
                      <td data-label="Status">
                        <Status>
                          {invoice.isMerged ? "merged" : invoice.status}
                        </Status>
                      </td>
                      <td className="row-actions-column" data-label="Actions">
                        <div className="action-row">
                          <button
                            className="icon-button table-action-button"
                            aria-label={`View ${invoice.invoiceCode}`}
                            onClick={() => void openDetail(invoice)}
                          >
                            <FileText size={16} aria-hidden="true" /><span>View</span>
                          </button>
                          {!invoice.isMerged && (
                            <button
                              className="icon-button danger table-action-button"
                              aria-label={`Delete ${invoice.invoiceCode}`}
                              onClick={() => void confirmDelete(invoice)}
                            >
                              <Trash2 size={16} aria-hidden="true" /><span>Delete</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={invoiceTotal}
              offset={invoiceOffset}
              pageSize={100}
              onChange={setInvoiceOffset}
            />
          </>
        ) : (
          <Empty message="No invoices found" />
        )}
      </article>
      {detail && (
        <Modal title={detail.invoiceCode} onClose={() => setDetail(undefined)}>
          <InvoiceDetailView invoice={detail} />
          {settings ? (
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() =>
                  void documents().then(async ({ invoicePdfBytes, pdfPreviewUrl }) => {
                    const url = pdfPreviewUrl(await invoicePdfBytes(detail, settings));
                    setPdfPreview({ title: `${detail.invoiceCode} preview`, url });
                  }).catch((cause: Error) => setNotice({ kind: "error", message: cause.message || "Could not preview the invoice PDF." }))
                }
              >
                <Eye size={16} /> Preview PDF
              </button>
              <button
                className="secondary"
                onClick={() =>
                  void documents().then(({ downloadInvoice }) =>
                    downloadInvoice(detail, settings),
                  ).catch((cause: Error) =>
                    setNotice({ kind: "error", message: cause.message || "Could not create the invoice PDF." }),
                  )
                }
              >
                <Download size={16} /> Download PDF
              </button>
              <button
                className="primary"
                onClick={() =>
                  void documents().then(({ shareInvoice }) =>
                    shareInvoice(detail, settings),
                  ).catch((cause: Error) =>
                    setNotice({ kind: "error", message: cause.message || "Could not share the invoice." }),
                  )
                }
              >
                <Share2 size={16} /> Share
              </button>
            </div>
          ) : (
            <DocumentSetupNotice serviceType={serviceType} />
          )}
        </Modal>
      )}
      {pdfPreview ? <PdfPreviewModal title={pdfPreview.title} url={pdfPreview.url} onClose={() => { URL.revokeObjectURL(pdfPreview.url); setPdfPreview(undefined); }} /> : null}
      {billingDialog === "single" && (
        <Modal
          title="Add Service Recharge"
          onClose={() => setBillingDialog(undefined)}
        >
          <InvoiceForm
            serviceType={serviceType}
            customers={billable}
            onCancel={() => setBillingDialog(undefined)}
            onCreated={(result) => {
              setBillingDialog(undefined);
              setNotice({
                kind: "success",
                message: result.replayed
                  ? `${result.invoiceCode} already existed; no duplicate was created.${result.paymentCode ? ` Payment ${result.paymentCode} recorded.` : ""}`
                  : `Recharge saved through ${formatBusinessDate(result.periodEnd)}. Bill ${result.invoiceCode} created.${result.paymentCode ? ` Payment ${result.paymentCode} recorded.` : ""}`,
              });
              refresh();
            }}
          />
        </Modal>
      )}
      {(billingDialog === "bulk" || billingDialog === "due") && (
        <Modal wide title={billingDialog === "due" ? "Review Due Recharges" : "Recharge Many Customers"} onClose={() => { setBillingDialog(undefined); setBulkPreview(undefined); }}>
          <form className="modal-form single-column" onSubmit={submitBulk}>
            <div className="modal-form-body">
            <label>
              Include Complete 30-Day Periods Ending By *
              <input
                name="throughMonth"
                type="month"
                autoComplete="off"
                value={bulkThroughMonth}
                onChange={(event) => { setBulkThroughMonth(event.target.value); setBulkPreview(undefined); }}
                required
              />
            </label>
            <fieldset className="bulk-customer-picker">
              <legend>Choose Customers</legend>
              <div className="bulk-picker-heading"><p>{bulkSelection.length ? `${bulkSelection.length} selected` : "No customers selected"}</p><span><button type="button" className="text-button" onClick={() => { setBulkSelection(billable.map((customer) => customer.id)); setBulkPreview(undefined); }}>Select All Listed</button><button type="button" className="text-button" onClick={() => { setBulkSelection([]); setBulkPreview(undefined); }}>Clear</button></span></div>
              <div>
                {billable.map((customer) => (
                  <label key={customer.id}>
                    <input
                      name="bulkCustomerIds"
                      type="checkbox"
                      value={customer.id}
                      checked={bulkSelection.includes(customer.id)}
                      onChange={(event) => {
                        setBulkPreview(undefined);
                        setBulkSelection((current) =>
                          event.target.checked
                            ? [...current, customer.id]
                            : current.filter((id) => id !== customer.id),
                        );
                      }}
                    />{" "}
                    <span>
                      {customer.name}
                      <small>
                        {customer.customerCode} · starts{" "}
                        {formatBusinessDate(customer.nextBillingStartDate!)}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="form-help">Nothing is created until you review the result. A conflict blocks that customer completely; other ready customers can still be processed.</p>
            {bulkPreview ? <section className="bulk-review" aria-live="polite"><div className="bulk-review-summary"><span><strong>{bulkPreview.ready.length}</strong> Ready</span><span><strong>{bulkPreview.failed.length}</strong> Need Attention</span><span><strong>{bulkPreview.skipped.length}</strong> No Complete Period</span><span><strong>{formatRupees(bulkPreview.ready.reduce((sum, item) => sum + item.amountPaise, 0))}</strong> Recharge Total</span></div><div className="bulk-review-list">{bulkPreview.ready.map((item) => <div className="ready" key={`ready-${item.customerId}`}><span><strong>{item.customerName}</strong><small>{item.customerCode} · {item.cycles * 30} days</small></span><span>{formatBusinessDate(item.periodStart)} – {formatBusinessDate(item.periodEnd)}</span><strong>{formatRupees(item.amountPaise)}</strong></div>)}{bulkPreview.failed.map((item) => <div className="blocked" key={`failed-${item.customerId}`}><span><strong>{item.customerName ?? `Customer ${item.customerId}`}</strong><small>{item.customerCode || "Needs review"}</small></span><span>{item.reason}</span><strong>Blocked</strong></div>)}{bulkPreview.skipped.map((item) => <div className="skipped" key={`skipped-${item.customerId}`}><span><strong>{item.customerName}</strong><small>{item.customerCode}</small></span><span>{item.reason}</span><strong>Skipped</strong></div>)}</div></section> : null}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => { setBillingDialog(undefined); setBulkPreview(undefined); }}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={submitting || !bulkSelection.length || Boolean(bulkPreview && !bulkPreview.ready.length)}
              >
                <Users size={16} />{" "}
                {submitting
                  ? "Working…"
                  : bulkPreview
                    ? `Create ${bulkPreview.ready.length} Bill${bulkPreview.ready.length === 1 ? "" : "s"}`
                    : `Review ${bulkSelection.length} Customer${bulkSelection.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {confirming === "merge" && (
        <Modal title="Merge Invoices" onClose={() => setConfirming(undefined)}>
          <div className="confirm-content">
            <span className="confirm-icon">
              <Merge size={20} aria-hidden="true" />
            </span>
            <div>
              <h3>Merge {selected.length} invoices?</h3>
              <p>
                The selected fully unpaid invoices will become one combined
                invoice. Source records remain preserved in the audit history.
              </p>
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={submitting}
                onClick={() => void mergeSelected()}
              >
                {submitting ? "Merging…" : "Merge Invoices"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {confirming && confirming !== "merge" && (
        <Modal title="Delete Invoice" onClose={() => setConfirming(undefined)}>
          <div className="confirm-content">
            <span className="confirm-icon">
              <Trash2 size={20} aria-hidden="true" />
            </span>
            <div>
              <h3>Delete {confirming.invoiceCode}?</h3>
              <p>
                {!deletePreview
                  ? "Calculating the exact ledger impact…"
                  : deletePreview.payments.length
                    ? `${deletePreview.payments.filter((payment) => payment.sharedInvoiceCount === 0).length} payment(s) will be removed; ${deletePreview.payments.filter((payment) => payment.sharedInvoiceCount > 0).length} shared payment(s) will remain and be reallocated. ${deletePreview.affectedInvoices.length} other invoice(s) may change. Coverage and the next billing date will be recalculated.`
                    : confirming.isCombined
                      ? "The combined invoice will be deleted and its original source invoices restored."
                      : "No linked payments will be deleted. Coverage and the next billing date will be recalculated."}
              </p>
              {deletePreview?.payments.map((payment) => (
                <small key={payment.id}>
                  {payment.paymentCode}: received{" "}
                  {formatRupees(payment.amountReceivedPaise)}, discount{" "}
                  {formatRupees(payment.discountGivenPaise)}
                </small>
              ))}
              <label>
                Deletion Reason (optional)
                <textarea
                  value={deleteReason}
                  onChange={(event) => setDeleteReason(event.target.value)}
                  maxLength={250}
                  placeholder="Add a note only if useful for the audit history"
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary danger-button"
                disabled={submitting || !deletePreview}
                onClick={() => void remove(confirming)}
              >
                {submitting ? "Deleting…" : "Delete Invoice"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function PaymentsPage({ serviceType }: { serviceType: ServiceType }) {
  const today = todayInBusinessTimezone();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [settings, setSettings] = useState<BusinessSettings>();
  const [customerId, setCustomerId] = useState("");
  const [detail, setDetail] = useState<PaymentDetail>();
  const [pdfPreview, setPdfPreview] = useState<{ title: string; url: string }>();
  const [filters, setFilters] = useState({
    query: "",
    from: "",
    to: "",
    mode: "",
  });
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi">("cash");
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [paymentTotal, setPaymentTotal] = useState(0);
  const [paymentOffset, setPaymentOffset] = useState(0);
  const [reversing, setReversing] = useState<Payment>();
  const [reversalReason, setReversalReason] = useState("");
  const [reversalPreview, setReversalPreview] =
    useState<PaymentDeletePreview>();
  const [paymentRequestKey, setPaymentRequestKey] = useState(() =>
    crypto.randomUUID(),
  );
  const deferredPaymentQuery = useDebouncedValue(filters.query, 300);
  const paymentRequestFilters = useMemo(
    () => ({
      query: deferredPaymentQuery,
      from: filters.from,
      to: filters.to,
      mode: filters.mode,
      offset: String(paymentOffset),
    }),
    [
      deferredPaymentQuery,
      filters.from,
      filters.mode,
      filters.to,
      paymentOffset,
    ],
  );
  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([
      listCustomers(serviceType, '', false, { limit: 500 }),
      listPayments(serviceType, paymentRequestFilters),
      getSettings(),
    ])
      .then(([active, nextPayments, nextSettings]) => {
        setCustomers(active.items);
        setPayments(nextPayments.items);
        setPaymentTotal(nextPayments.total);
        setSettings(nextSettings ?? undefined);
      })
      .catch((error: Error) =>
        setNotice({ kind: "error", message: error.message }),
      )
      .finally(() => setLoading(false));
  }, [paymentRequestFilters, serviceType]);
  useEffect(() => {
    setPaymentOffset(0);
  }, [
    deferredPaymentQuery,
    filters.from,
    filters.mode,
    filters.to,
    serviceType,
  ]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const customer = customers.find((item) => item.id === Number(customerId));
  const adjustedDue = customer
    ? Math.max(0, customer.amountDuePaise - customer.creditBalancePaise)
    : 0;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    try {
      const result = await createPayment(serviceType, {
        customerId: Number(data.get("customerId")),
        paymentDate: String(data.get("paymentDate")),
        amountReceivedPaise: rupeesToPaise(String(data.get("amount"))),
        discountGivenPaise: rupeesToPaise(String(data.get("discount") || "0")),
        paymentMode: data.get("paymentMode") === "upi" ? "upi" : "cash",
        paymentReference: String(data.get("paymentReference") || "").trim() || undefined,
        notes: String(data.get("notes")) || undefined,
        requestKey: paymentRequestKey,
      });
      form.reset();
      setPaymentRequestKey(crypto.randomUUID());
      setCustomerId("");
      setPaymentMode("cash");
      setPaymentOpen(false);
      setNotice({
        kind: "success",
        message: `${result.paymentCode} ${result.replayed ? "already existed" : "recorded"} and allocated oldest-first.`,
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to record payment.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function remove(payment: Payment) {
    setSubmitting(true);
    try {
      await deletePayment(serviceType, payment.id, reversalReason);
      setReversing(undefined);
      setReversalReason("");
      setNotice({
        kind: "success",
        message: `${payment.paymentCode} reversed and the ledger replayed.`,
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to reverse payment.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function openDetail(payment: Payment) {
    try {
      setDetail(await getPayment(serviceType, payment.id));
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to load receipt.",
      });
    }
  }
  async function confirmReversal(payment: Payment) {
    setReversalReason("");
    setReversalPreview(undefined);
    setReversing(payment);
    try {
      setReversalPreview(
        await getPaymentDeletePreview(serviceType, payment.id),
      );
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to preview reversal.",
      });
      setReversing(undefined);
    }
  }
  async function exportPayments() {
    setSubmitting(true);
    try {
      const exported = await listAllPayments(serviceType, {
        query: deferredPaymentQuery,
        from: filters.from,
        to: filters.to,
        mode: filters.mode,
      });
      downloadCsv(
        `${serviceType}-payments.csv`,
        exported.map((payment) => ({
          Receipt: payment.paymentCode,
          Customer: payment.customerName,
          Date: payment.paymentDate,
          Mode: payment.paymentMode,
          Received: (payment.amountReceivedPaise / 100).toFixed(2),
          Discount: (payment.discountGivenPaise / 100).toFixed(2),
          Result: payment.resultingStatus,
        })),
      );
      setNotice({
        kind: "success",
        message: `${exported.length} matching payment(s) exported.`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to export payments.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="page-content">
      <PageTitle
        title="Payments"
        subtitle="Record collections and review customer payment history."
        action={
          <div className="page-actions">
            <button
              className="secondary"
              disabled={submitting}
              onClick={() => void exportPayments()}
            >
              <Download size={16} /> Export
            </button>
            <button
              className="primary"
              onClick={() => {
                setPaymentRequestKey(crypto.randomUUID());
                setPaymentMode("cash");
                setPaymentOpen(true);
              }}
            >
              <Banknote size={16} /> Record Payment
            </button>
          </div>
        }
      />
      {notice && <NoticeMessage notice={notice} />}
      <article className="panel table-panel responsive-register payment-register">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Collection history</p>
            <h2>Payment History</h2>
          </div>
        </div>
        <div className="filter-grid">
          <label>
            Search
            <input
              name="paymentSearch"
              autoComplete="off"
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  query: event.target.value,
                }))
              }
              placeholder="Search receipt, customer, ID, or STB…"
            />
          </label>
          <label>
            From
            <input
              name="paymentFrom"
              type="date"
              value={filters.from}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
            />
          </label>
          <label>
            To
            <input
              name="paymentTo"
              type="date"
              value={filters.to}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  to: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Mode
            <select
              name="paymentModeFilter"
              value={filters.mode}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  mode: event.target.value,
                }))
              }
            >
              <option value="">All</option>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="system_credit">System credit</option>
            </select>
          </label>
        </div>
        {loading ? (
          <p className="empty-inline" role="status">
            Loading payments…
          </p>
        ) : payments.length ? (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Customer</th>
                    <th>Date</th>
                    <th>Received</th>
                    <th>Mode</th>
                    <th className="row-actions-column">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td data-label="Receipt">
                        <strong>{payment.paymentCode}</strong>
                        <small>
                          <Status>{payment.resultingStatus}</Status>
                        </small>
                        {payment.paymentReference ? <small>Ref {payment.paymentReference}</small> : null}
                      </td>
                      <td data-label="Customer">{payment.customerName}</td>
                      <td data-label="Date">
                        {formatBusinessDate(payment.paymentDate)}
                      </td>
                      <td data-label="Received">
                        {formatRupees(payment.amountReceivedPaise)}
                        <small>
                          Discount {formatRupees(payment.discountGivenPaise)}
                        </small>
                      </td>
                      <td data-label="Mode">
                        {payment.paymentMode.replace("_", " ").toUpperCase()}
                      </td>
                      <td className="row-actions-column" data-label="Actions">
                        <div className="action-row">
                          <button
                            className="icon-button table-action-button"
                            aria-label={`View ${payment.paymentCode}`}
                            onClick={() => void openDetail(payment)}
                          >
                            <ReceiptText size={16} aria-hidden="true" /><span>View</span>
                          </button>
                          {payment.paymentMode !== "system_credit" && (
                            <button
                              className="icon-button danger table-action-button"
                              aria-label={`Reverse ${payment.paymentCode}`}
                              onClick={() => void confirmReversal(payment)}
                            >
                              <Trash2 size={16} aria-hidden="true" /><span>Reverse</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={paymentTotal}
              offset={paymentOffset}
              pageSize={100}
              onChange={setPaymentOffset}
            />
          </>
        ) : (
          <Empty message="No payments found" />
        )}
      </article>
      {detail && (
        <Modal title={detail.paymentCode} onClose={() => setDetail(undefined)}>
          <PaymentDetailView payment={detail} />
          {detail.paymentMode === "system_credit" ? null : settings ? (
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() =>
                  void documents().then(async ({ pdfPreviewUrl, receiptPdfBytes }) => {
                    const url = pdfPreviewUrl(await receiptPdfBytes(detail, settings));
                    setPdfPreview({ title: `${detail.paymentCode} preview`, url });
                  }).catch((cause: Error) => setNotice({ kind: "error", message: cause.message || "Could not preview the payment receipt." }))
                }
              >
                <Eye size={16} /> Preview PDF
              </button>
              <button
                className="secondary"
                onClick={() =>
                  void documents().then(({ downloadReceipt }) =>
                    downloadReceipt(detail, settings),
                  ).catch((cause: Error) =>
                    setNotice({ kind: "error", message: cause.message || "Could not create the payment receipt." }),
                  )
                }
              >
                <Download size={16} /> Download PDF
              </button>
              <button
                className="primary"
                onClick={() =>
                  void documents().then(({ shareReceipt }) =>
                    shareReceipt(detail, settings),
                  ).catch((cause: Error) =>
                    setNotice({ kind: "error", message: cause.message || "Could not share the payment receipt." }),
                  )
                }
              >
                <Share2 size={16} /> Share
              </button>
            </div>
          ) : (
            <DocumentSetupNotice serviceType={serviceType} />
          )}
        </Modal>
      )}
      {pdfPreview ? <PdfPreviewModal title={pdfPreview.title} url={pdfPreview.url} onClose={() => { URL.revokeObjectURL(pdfPreview.url); setPdfPreview(undefined); }} /> : null}
      {paymentOpen && (
        <Modal title="Record Payment" onClose={() => setPaymentOpen(false)}>
          <form className="modal-form single-column" onSubmit={submit}>
            <div className="modal-form-body">
            <label>
              Customer *
              <select
                name="customerId"
                required
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
              >
                <option value="" disabled>
                  Select customer
                </option>
                {customers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.customerCode}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-help">
              Restore archived customers from Customers before recording a payment.
            </p>
            {customer && (
              <div className="due-summary">
                <span>
                  Customer Owes{" "}
                  <strong className="amount-due">
                    {formatRupees(customer.amountDuePaise)}
                  </strong>
                </span>
                <span>
                  Customer Credit{" "}
                  <strong className="amount-credit">
                    {formatRupees(customer.creditBalancePaise)}
                  </strong>
                </span>
                <span>
                  Pay Now{" "}
                  <strong className={adjustedDue > 0 ? "amount-due" : ""}>
                    {formatRupees(adjustedDue)}
                  </strong>
                </span>
              </div>
            )}
            {customer && customer.unbilledOpeningDuePaise > 0 ? (
              <p className="form-help">
                Create the first bill before recording this payment if you need a discount. Otherwise, {formatRupees(customer.unbilledOpeningDuePaise)} will be safely held as customer credit.
              </p>
            ) : null}
              <label>
                Payment Method
                <select name="paymentMode" value={paymentMode} onChange={(event) => setPaymentMode(event.target.value === "upi" ? "upi" : "cash")}>
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                </select>
              </label>
            {paymentMode === "upi" ? <label>
              UPI Reference / UTR *
              <input
                name="paymentReference"
                maxLength={120}
                autoComplete="off"
                placeholder="Enter the UPI transaction reference…"
                required
              />
            </label> : null}
            {customer ? (
              <PaymentAmountFields
                key={customerId}
                duePaise={adjustedDue}
                holdAsCredit={customer.unbilledOpeningDuePaise > 0}
              />
            ) : null}
            <details className="advanced-options" open><summary>Payment Date & Notes</summary><label>Payment Date<input name="paymentDate" type="date" max={today} defaultValue={today} required /></label><label>Notes<input name="notes" autoComplete="off" maxLength={500} placeholder="Optional collection note…" /></label></details>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setPaymentOpen(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={submitting || !customerId}>
                <Banknote size={16} />{" "}
                {submitting ? "Recording…" : "Record Payment"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {reversing && (
        <Modal title="Reverse Payment" onClose={() => setReversing(undefined)}>
          <div className="confirm-content">
            <span className="confirm-icon">
              <Trash2 size={20} aria-hidden="true" />
            </span>
            <div>
              <h3>Reverse {reversing.paymentCode}?</h3>
              <p>
                {!reversalPreview
                  ? "Calculating the exact ledger impact…"
                  : `${reversalPreview.invoices.length} invoice(s) will be recalculated. They may return to partial or unpaid status, and remaining payments will be replayed oldest-first.`}
              </p>
              {reversalPreview?.invoices.map((invoice) => (
                <small key={invoice.invoiceCode}>
                  {invoice.invoiceCode}: currently {invoice.status}, allocated{" "}
                  {formatRupees(invoice.allocatedPaise)}
                </small>
              ))}
              <label>
                Reversal Reason (optional)
                <textarea
                  value={reversalReason}
                  onChange={(event) => setReversalReason(event.target.value)}
                  maxLength={250}
                  placeholder="Add a note only if useful"
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setReversing(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary danger-button"
                disabled={
                  submitting ||
                  !reversalPreview
                }
                onClick={() => void remove(reversing)}
              >
                {submitting ? "Reversing…" : "Reverse Payment"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ExpensesPage() {
  const today = todayInBusinessTimezone();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [filters, setFilters] = useState({ from: "", to: "", category: "" });
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [deleting, setDeleting] = useState<Expense>();
  const [deleteReason, setDeleteReason] = useState("");
  const refresh = useCallback(() => {
    setLoading(true);
    listExpenses(filters)
      .then(setExpenses)
      .catch((error: Error) =>
        setNotice({ kind: "error", message: error.message }),
      )
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const categories = useMemo(
    () => [...new Set(expenses.map((item) => item.category))],
    [expenses],
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    try {
      await createExpense({
        description: String(data.get("description")),
        category: String(data.get("category")),
        expenseDate: String(data.get("expenseDate")),
        amountPaise: rupeesToPaise(String(data.get("amount"))),
      });
      form.reset();
      setExpenseOpen(false);
      setNotice({ kind: "success", message: "Expense saved." });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to save expense.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function remove(expense: Expense) {
    setSubmitting(true);
    try {
      await deleteExpense(expense.id, deleteReason);
      setDeleting(undefined);
      setDeleteReason("");
      setNotice({
        kind: "success",
        message: "Expense deleted; its audit record is retained.",
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to delete expense.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  function exportExpenses() {
    downloadCsv(
      "expenses.csv",
      expenses.map((expense) => ({
        Date: expense.expenseDate,
        Description: expense.description,
        Category: expense.category,
        Amount: (expense.amountPaise / 100).toFixed(2),
      })),
    );
  }
  return (
    <section className="page-content">
      <PageTitle
        title="Expenses"
        subtitle="Operating costs and monthly burn rate."
        action={
          <div className="page-actions">
            <button className="secondary" onClick={exportExpenses}>
              <Download size={16} /> Export CSV
            </button>
            <button className="primary" onClick={() => setExpenseOpen(true)}>
              <ReceiptText size={16} aria-hidden="true" /> Add Expense
            </button>
          </div>
        }
      />
      {notice && <NoticeMessage notice={notice} />}
      <article className="panel table-panel responsive-register expense-register">
        <div className="panel-heading">
          <h2>Expense Register</h2>
        </div>
        <div className="filter-grid">
          <label>
            From
            <input
              name="expenseFrom"
              type="date"
              value={filters.from}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
            />
          </label>
          <label>
            To
            <input
              name="expenseTo"
              type="date"
              value={filters.to}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  to: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Category
            <select
              name="expenseCategoryFilter"
              value={filters.category}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  category: event.target.value,
                }))
              }
            >
              <option value="">All</option>
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p className="empty-inline" role="status">
            Loading expenses…
          </p>
        ) : expenses.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Amount</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td data-label="Date">
                      {formatBusinessDate(expense.expenseDate)}
                    </td>
                    <td data-label="Description">{expense.description}</td>
                    <td data-label="Category">{expense.category}</td>
                    <td data-label="Amount">
                      {formatRupees(expense.amountPaise)}
                    </td>
                    <td data-label="Actions">
                      <button
                        className="icon-button danger"
                        aria-label={`Delete ${expense.description}`}
                        onClick={() => setDeleting(expense)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty message="No expenses found" />
        )}
      </article>
      {expenseOpen && (
        <Modal title="Add Expense" onClose={() => setExpenseOpen(false)}>
          <form className="modal-form single-column" onSubmit={submit}>
            <div className="modal-form-body">
            <label>
              Description *
              <input
                name="description"
                autoComplete="off"
                required
                maxLength={250}
              />
            </label>
            <label>
              Category *
              <input
                name="category"
                autoComplete="off"
                list="expense-categories"
                required
                maxLength={80}
              />
              <datalist id="expense-categories">
                <option value="Fuel" />
                <option value="Salary" />
                <option value="Maintenance" />
                <option value="Office" />
                <option value="Internet" />
                <option value="Other" />
              </datalist>
            </label>
            <div className="balance-fields">
              <label>
                Date
                <input
                  name="expenseDate"
                  type="date"
                  max={today}
                  defaultValue={today}
                  required
                />
              </label>
              <label>
                Amount (₹)
                <input
                  name="amount"
                  autoComplete="off"
                  inputMode="decimal"
                  pattern="\d+(\.\d{1,2})?"
                  required
                />
              </label>
            </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setExpenseOpen(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={submitting}>
                <ReceiptText size={16} aria-hidden="true" />{" "}
                {submitting ? "Saving…" : "Save Expense"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal title="Delete Expense" onClose={() => setDeleting(undefined)}>
          <div className="confirm-content">
            <span className="confirm-icon">
              <Trash2 size={20} aria-hidden="true" />
            </span>
            <div>
              <h3>Delete this expense?</h3>
              <p>
                “{deleting.description}” for{" "}
                {formatRupees(deleting.amountPaise)} will be removed from active
                reports. Its audit record remains retained.
              </p>
              <label>
                Deletion Reason *
                <textarea
                  value={deleteReason}
                  onChange={(event) => setDeleteReason(event.target.value)}
                  minLength={5}
                  maxLength={250}
                  required
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setDeleting(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary danger-button"
                disabled={submitting || deleteReason.trim().length < 5}
                onClick={() => void remove(deleting)}
              >
                {submitting ? "Deleting…" : "Delete Expense"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ReportsPage({ serviceType }: { serviceType: ServiceType }) {
  const initialRange = currentMonthRange();
  const [scope, setScope] = useState<ServiceType | "all">(serviceType);
  const [filters, setFilters] = useState({
    from: initialRange.from,
    to: initialRange.to,
    areaId: "",
    paymentMode: "",
    discountGiven: "",
    dateBasis: "issued",
  });
  const [report, setReport] = useState<Report>();
  const [areas, setAreas] = useState<
    Array<{ id: number; displayName: string; serviceType?: ServiceType }>
  >([]);
  const [settings, setSettings] = useState<BusinessSettings>();
  const [pdfPreview, setPdfPreview] = useState<{ title: string; url: string }>();
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setReport(undefined);
    setError("");
    Promise.all([
      getCompleteReport(scope, filters),
      getSettings(),
      scope === "all"
        ? Promise.all([listAreas("cable"), listAreas("broadband")]).then(
            ([cable, broadband]) => [
              ...cable.map((area) => ({
                ...area,
                displayName: `${area.displayName} · Cable`,
                serviceType: "cable" as const,
              })),
              ...broadband.map((area) => ({
                ...area,
                displayName: `${area.displayName} · Broadband`,
                serviceType: "broadband" as const,
              })),
            ],
          )
        : listAreas(scope),
    ])
      .then(([nextReport, nextSettings, nextAreas]) => {
        setReport(nextReport);
        setSettings(nextSettings ?? undefined);
        setAreas(nextAreas);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [filters, scope]);
  useEffect(() => {
    setScope(serviceType);
    setFilters((current) => ({ ...current, areaId: "" }));
  }, [serviceType]);
  useEffect(() => {
    setFilters((current) =>
      current.areaId ? { ...current, areaId: "" } : current,
    );
  }, [scope]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <section className="page-content">
      <PageTitle
        title="Reports"
        subtitle="Filter collections and expenses, inspect ledgers, and export a complete audit view."
      />
      <div className="panel report-toolbar">
        <div className="service-tabs" role="group" aria-label="Report scope">
          <button
            className={scope === serviceType ? "active" : ""}
            aria-pressed={scope === serviceType}
            onClick={() => setScope(serviceType)}
          >
            {serviceType}
          </button>
          <button
            className={scope === "all" ? "active" : ""}
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            All business
          </button>
        </div>
        <div className="filter-grid">
          <label>
            From
            <input
              name="reportFrom"
              type="date"
              value={filters.from}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
            />
          </label>
          <label>
            To
            <input
              name="reportTo"
              type="date"
              value={filters.to}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  to: event.target.value,
                }))
              }
            />
          </label>
          <label>
            Area
            <select
              name="reportArea"
              value={filters.areaId}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  areaId: event.target.value,
                }))
              }
            >
              <option value="">All areas</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Payment mode
            <select
              name="reportPaymentMode"
              value={filters.paymentMode}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  paymentMode: event.target.value,
                }))
              }
            >
              <option value="">All</option>
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
            </select>
          </label>
          <label>
            Discount
            <select
              name="reportDiscount"
              value={filters.discountGiven}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  discountGiven: event.target.value,
                }))
              }
            >
              <option value="">All payments</option>
              <option value="1">Discount given</option>
            </select>
          </label>
          <label>
            Invoice date basis
            <select
              name="reportDateBasis"
              value={filters.dateBasis}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  dateBasis: event.target.value,
                }))
              }
            >
              <option value="issued">Issue date</option>
              <option value="service">Service start</option>
            </select>
          </label>
        </div>
      </div>
      {error ? (
        <ErrorNotice message={error} />
      ) : !report ? (
        <Loading label="Loading report…" />
      ) : (
        <>
          <section className="metrics">
            <Metric
              label={report.netLabel}
              value={formatRupees(report.netPaise)}
              hint={
                scope === "all"
                  ? "Collections minus shared expenses"
                  : "Shared expenses not deducted"
              }
            />
            <Metric
              label="Collected"
              value={formatRupees(report.collectedPaise)}
              hint="Actual cash and UPI received"
            />
            <Metric
              label="Discount given"
              value={formatRupees(report.discountGivenPaise)}
              hint="Invoice dues waived"
            />
            <Metric
              label="Outstanding"
              value={formatRupees(report.outstandingPaise)}
              hint="All current live balances"
            />
            <Metric
              label="Services active today"
              value={String(report.activeSubscribers)}
              hint={`${report.dataQualityCount} need billing setup`}
            />
          </section>
          <div className="export-actions">
            {settings ? (
              <>
              <button
                className="secondary"
                onClick={() =>
                  void documents().then(async ({ pdfPreviewUrl, reportPdfBytes }) => {
                    const url = pdfPreviewUrl(await reportPdfBytes(report, settings));
                    setPdfPreview({ title: "Business report preview", url });
                  }).catch((cause: Error) => setError(cause.message || "Could not preview the report PDF."))
                }
              >
                <Eye size={16} aria-hidden="true" /> Preview PDF
              </button>
              <button
                className="secondary"
                onClick={() =>
                  void documents().then(({ downloadReportPdf }) =>
                    downloadReportPdf(report, settings),
                  ).catch((cause: Error) =>
                    setError(cause.message || "Could not create the report PDF."),
                  )
                }
              >
                <Download size={16} aria-hidden="true" /> Download PDF
              </button>
              </>
            ) : (
              <DocumentSetupNotice serviceType={serviceType} />
            )}
            <button
              className="secondary"
              onClick={() =>
                void documents().then(({ downloadReportExcel }) =>
                  downloadReportExcel(report),
                ).catch((cause: Error) =>
                  setError(cause.message || "Could not export the report."),
                )
              }
            >
              <Download size={16} aria-hidden="true" /> Export Excel
            </button>
          </div>
          <article className="panel">
            <h2>Collected vs. billed trend</h2>
            <TrendChart trends={report.trends} />
          </article>
          <div className="report-ledgers">
            <LedgerTable
              title="Collection ledger"
              headers={["Subscriber", "Date", "Mode", "Received", "Discount"]}
              rows={report.payments.map((payment) => [
                payment.customerName,
                formatBusinessDate(payment.paymentDate),
                payment.paymentMode.toUpperCase(),
                formatRupees(payment.amountReceivedPaise),
                formatRupees(payment.discountGivenPaise),
              ])}
            />
            <LedgerTable
              title="Expenditure ledger"
              headers={["Category", "Date", "Description", "Amount"]}
              rows={report.expenses.map((expense) => [
                expense.category,
                formatBusinessDate(expense.expenseDate),
                expense.description,
                formatRupees(expense.amountPaise),
              ])}
            />
          </div>
        </>
      )}
      {pdfPreview ? <PdfPreviewModal title={pdfPreview.title} url={pdfPreview.url} onClose={() => { URL.revokeObjectURL(pdfPreview.url); setPdfPreview(undefined); }} /> : null}
    </section>
  );
}

export function RemindersPage({ serviceType }: { serviceType: ServiceType }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState("");
  const today = todayInBusinessTimezone();
  useEffect(() => {
    listCustomers(serviceType, '', false, { limit: 500 })
      .then((result) => setCustomers(result.items))
      .catch((cause: Error) => setError(cause.message));
  }, [serviceType]);
  const actionable = customers.filter(
    (customer) =>
      (customer.amountDuePaise - customer.creditBalancePaise > 0 ||
        (customer.latestPeriodEnd &&
          customer.latestPeriodEnd >= today &&
          daysBetween(today, customer.latestPeriodEnd) <= 3)),
  );
  function remind(customer: Customer) {
    const phone = (customer.phone ?? "").replace(/\D/g, "");
    const message =
      customer.amountDuePaise - customer.creditBalancePaise > 0
        ? `Hello ${customer.name}, your Sitaram ${serviceType} account has an outstanding balance of ${formatRupees(customer.amountDuePaise - customer.creditBalancePaise)}. Please contact us after payment.`
        : `Hello ${customer.name}, your ${customer.planName ?? serviceType} service expires on ${formatBusinessDate(customer.latestPeriodEnd!)}. Please contact Sitaram to renew.`;
    window.open(
      `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }
  return (
    <section className="page-content">
      <PageTitle
        title="Reminders"
        subtitle="Send deliberate WhatsApp reminders—no fake delivery or success statistics."
      />
      {error ? (
        <ErrorNotice message={error} />
      ) : (
        <article className="panel table-panel responsive-register reminder-register">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Action queue</p>
              <h2>Expiring and overdue subscribers</h2>
            </div>
            <span>{actionable.length} ready</span>
          </div>
          {actionable.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Subscriber</th>
                    <th>Reason</th>
                    <th>Contact</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {actionable.map((customer) => (
                    <tr key={customer.id}>
                      <td data-label="Subscriber">
                        <strong>{customer.name}</strong>
                        <small>
                          {customer.customerCode} ·{" "}
                          {customer.planName ?? "No plan"}
                        </small>
                      </td>
                      <td data-label="Reason">
                        {customer.amountDuePaise - customer.creditBalancePaise > 0 ? (
                          <>
                            <strong className="amount-due">
                              {formatRupees(customer.amountDuePaise - customer.creditBalancePaise)} overdue
                            </strong>
                            <small>
                              {customer.oldestDuePeriodStart
                                ? `From ${formatBusinessDate(customer.oldestDuePeriodStart)}`
                                : "Previous opening balance"}
                            </small>
                          </>
                        ) : (
                          <>
                            <strong>
                              Expires{" "}
                              {formatBusinessDate(customer.latestPeriodEnd!)}
                            </strong>
                            <small>Renewal reminder</small>
                          </>
                        )}
                      </td>
                      <td data-label="Contact">
                        {customer.phone || <span className="amount-due">Phone number required</span>}
                      </td>
                      <td data-label="Action">
                        <button
                          className="secondary"
                          disabled={!customer.phone}
                          title={customer.phone ? "Open WhatsApp reminder" : "Add a phone number to the subscriber before sending a reminder"}
                          onClick={() => remind(customer)}
                        >
                          <MessageCircle size={16} /> {customer.phone ? "WhatsApp" : "Add phone first"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty message="No subscribers currently need a reminder" />
          )}
        </article>
      )}
    </section>
  );
}

function daysBetween(from: string, to: string) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<BusinessSettings>({
    businessName: "Sitaram Billing",
    address: "",
    phoneNumbers: "",
    upiId: "",
    logoUrl: null,
  });
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(() => window.localStorage.getItem(BACKUP_STORAGE_KEY));
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  useEffect(() => {
    getSettings()
      .then((result) => {
        if (result) setSettings(result);
      })
      .catch((error: Error) =>
        setNotice({ kind: "error", message: error.message }),
      )
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { listAuditEvents({ limit: 12 }).then((result) => setAuditEvents(result.items)).catch(() => setAuditEvents([])).finally(() => setAuditLoading(false)); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await saveSettings(settings);
      setNotice({ kind: "success", message: "Business settings saved." });
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to save settings.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = String(data.get("newPassword"));
    if (next !== String(data.get("confirmPassword")))
      return setNotice({
        kind: "error",
        message: "New password confirmation does not match.",
      });
    setSubmitting(true);
    try {
      await changePassword(String(data.get("currentPassword")), next);
      form.reset();
      setNotice({ kind: "success", message: "Admin password changed." });
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to change password.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  const update = (field: keyof BusinessSettings, value: string) =>
    setSettings((current) => ({
      ...current,
      [field]: field === "logoUrl" ? value || null : value,
    }));
  return (
    <section className="page-content">
      <PageTitle
        title="Settings"
        subtitle="Business identity feeds every generated document; authentication remains server-side."
      />
      {notice && <NoticeMessage notice={notice} />}
      {loading ? (
        <Loading label="Loading settings…" />
      ) : (
        <div className="settings-grid">
          <article className="panel form-panel">
            <h2>Business profile</h2>
            <form onSubmit={submit}>
              <label>
                Business name
                <input
                  name="businessName"
                  autoComplete="organization"
                  value={settings.businessName}
                  onChange={(event) =>
                    update("businessName", event.target.value)
                  }
                  required
                  maxLength={160}
                />
              </label>
              <label>
                Address
                <textarea
                  name="businessAddress"
                  autoComplete="street-address"
                  value={settings.address}
                  onChange={(event) => update("address", event.target.value)}
                  required
                  maxLength={500}
                />
              </label>
              <label>
                Phone numbers
                <input
                  name="businessPhones"
                  autoComplete="tel"
                  value={settings.phoneNumbers}
                  onChange={(event) =>
                    update("phoneNumbers", event.target.value)
                  }
                  required
                  maxLength={120}
                />
              </label>
              <label>
                UPI ID
                <input
                  name="upiId"
                  autoComplete="off"
                  spellCheck={false}
                  value={settings.upiId}
                  onChange={(event) => update("upiId", event.target.value)}
                  required
                  maxLength={160}
                />
              </label>
              <label>
                Externally hosted logo URL
                <input
                  name="logoUrl"
                  autoComplete="url"
                  type="url"
                  placeholder="https://example.com/logo.png"
                  value={settings.logoUrl ?? ""}
                  onChange={(event) => update("logoUrl", event.target.value)}
                />
              </label>
              <button className="primary" disabled={submitting}>
                {submitting ? "Saving…" : "Save settings"}
              </button>
            </form>
          </article>
          <article className="panel form-panel">
            <h2>Change admin password</h2>
            <form onSubmit={password}>
              <label>
                Current password
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <label>
                New password
                <input
                  name="newPassword"
                  type="password"
                  minLength={10}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label>
                Confirm new password
                <input
                  name="confirmPassword"
                  type="password"
                  minLength={10}
                  autoComplete="new-password"
                  required
                />
              </label>
              <button className="primary" disabled={submitting}>
                Change password
              </button>
            </form>
            <div className="backup-box">
              <p className="eyebrow">Data safety</p>
              <h2>Manual backup</h2>
              <p>
                Download all operational and audit records. Password hashes are
                excluded.
              </p>
              <p className="form-help">{lastBackupLabel(lastBackup)}</p>
              <a className="secondary" href="/api/backup" onClick={() => { markBackupDownloaded(); setLastBackup(new Date().toISOString()); }}>
                Download JSON backup
              </a>
              {lastBackup && Date.now() - new Date(lastBackup).getTime() > 7 * 86400000 ? <p className="form-error" role="status">This backup is more than 7 days old. Download a fresh copy.</p> : null}
            </div>
            <div className="audit-box">
              <p className="eyebrow">Accountability</p>
              <h2>Recent audit activity</h2>
              <p className="form-help">Corrections, deletions, payments, and billing changes are retained here.</p>
              {auditLoading ? <p className="empty-inline" role="status">Loading audit history…</p> : auditEvents.length ? <div className="audit-list" role="list">{auditEvents.map((event) => <div className="audit-row" role="listitem" key={event.id}><span><strong>{event.action.replaceAll('_', ' ')}</strong><small>{event.entityType} #{event.entityId}{event.reason ? ` · ${event.reason}` : ''}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div>)}</div> : <p className="empty-inline" role="status">No audit activity yet.</p>}
            </div>
          </article>
        </div>
      )}
    </section>
  );
}

function InvoiceDetailView({ invoice }: { invoice: InvoiceDetail }) {
  return (
    <div className="detail-grid">
      <Detail
        label="Customer"
        value={`${invoice.customerName} · ${invoice.customerCode}`}
      />
      <Detail
        label="Area / Plan"
        value={`${invoice.areaName} · ${invoice.planName}`}
      />
      <Detail
        label="Service period"
        value={`${formatBusinessDate(invoice.periodStart)} to ${formatBusinessDate(invoice.periodEnd)}`}
      />
      <Detail label="Due date" value={formatBusinessDate(invoice.dueDate)} />
      <Detail label="Status" value={invoice.status.toUpperCase()} />
      <Detail
        label="Previous due at issue"
        value={formatRupees(invoice.previousDueSnapshotPaise)}
      />
      <Detail
        label="Current period"
        value={formatRupees(invoice.currentPeriodAmountPaise)}
      />
      <Detail
        label="Total payable at issue"
        value={formatRupees(invoice.totalPayablePaise)}
      />
      <Detail
        label="Live invoice balance"
        value={formatRupees(invoice.liveBalancePaise)}
      />
      <Detail
        label="Current total customer due"
        value={formatRupees(invoice.currentCustomerDuePaise)}
      />
      {invoice.mergeItems.map((item) => (
        <Detail
          key={item.invoiceCode}
          label={item.invoiceCode}
          value={`${item.planName} · ${formatBusinessDate(item.periodStart)} to ${formatBusinessDate(item.periodEnd)} · ${formatRupees(item.amountPaise)}`}
        />
      ))}
      {invoice.allocations.map((item) => (
        <Detail
          key={`${item.paymentCode}-${item.paymentDate}-${item.chargeType ?? "invoice"}`}
          label={`${item.paymentCode}${item.chargeType === "opening_due" ? " · Previous due" : item.chargeType === "service" ? " · Service charge" : ""}`}
          value={`${formatBusinessDate(item.paymentDate)} · Cash ${formatRupees(item.cashPaise)} · Discount ${formatRupees(item.discountPaise)} · Credit ${formatRupees(item.creditPaise)}`}
        />
      ))}
    </div>
  );
}
function PaymentDetailView({ payment }: { payment: PaymentDetail }) {
  return (
    <div className="detail-grid">
      <Detail
        label="Customer"
        value={`${payment.customerName} · ${payment.customerCode}`}
      />
      <Detail
        label="Area / STB"
        value={`${payment.areaName} · ${payment.stbNumber || "N/A"}`}
      />
      <Detail
        label="Date / Mode"
        value={`${formatBusinessDate(payment.paymentDate)} · ${payment.paymentMode.replace("_", " ")}`}
      />
      <Detail
        label="Amount received"
        value={formatRupees(payment.amountReceivedPaise)}
      />
      <Detail label="UTR / payment reference" value={payment.paymentReference || "—"} />
      <Detail
        label="Discount"
        value={formatRupees(payment.discountGivenPaise)}
      />
      <Detail
        label="Resulting status"
        value={payment.resultingStatus.replace("_", " ").toUpperCase()}
      />
      <Detail label="Notes" value={payment.notes || "—"} />
      {payment.allocations.map((item) => (
        <Detail
          key={`${item.invoiceCode}-${item.periodStart}-${item.chargeType ?? "invoice"}`}
          label={`${item.invoiceCode}${item.chargeType === "opening_due" ? " · Previous due" : item.chargeType === "service" ? " · Service charge" : ""}`}
          value={`${formatBusinessDate(item.periodStart)} to ${formatBusinessDate(item.periodEnd)} · Cash ${formatRupees(item.cashPaise)} · Discount ${formatRupees(item.discountPaise)} · Credit ${formatRupees(item.creditPaise)}`}
        />
      ))}
    </div>
  );
}
function PdfPreviewModal({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  return <Modal title={title} onClose={onClose} wide><iframe className="pdf-preview-frame" title={title} src={url} /></Modal>
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
function DocumentSetupNotice({ serviceType }: { serviceType: ServiceType }) {
  return (
    <p className="document-setup" role="note">
      Complete{" "}
      <a href={`#/settings?service=${serviceType}`}>Business Settings</a> to
      enable PDF downloads and sharing.
    </p>
  );
}
function Pagination({
  total,
  offset,
  pageSize,
  onChange,
}: {
  total: number;
  offset: number;
  pageSize: number;
  onChange: (offset: number) => void;
}) {
  if (total <= pageSize) return null;
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.ceil(total / pageSize);
  return (
    <nav className="pagination" aria-label="Table pages">
      <button
        className="secondary"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        Previous
      </button>
      <span>
        Page {page} of {pages} · {total} records
      </span>
      <button
        className="secondary"
        disabled={offset + pageSize >= total}
        onClick={() => onChange(offset + pageSize)}
      >
        Next
      </button>
    </nav>
  );
}
export function BackupPage() {
  const [lastBackup, setLastBackup] = useState<string | null>(() => window.localStorage.getItem(BACKUP_STORAGE_KEY));
  return (
    <section className="page-content">
      <PageTitle
        title="Manual Backup"
        subtitle="Download a complete, read-only JSON export of your workspace."
      />
      <div className="backup-layout">
        <article className="panel backup-card">
          <div className="feature-icon">
            <HardDriveDownload aria-hidden="true" />
          </div>
          <h2>Export Full Backup</h2>
          <p>
            Includes subscribers, invoices, payments, allocations, expenses,
            plans, areas, settings, and number sequences. Administrator
            credentials are excluded.
          </p>
          <div className="backup-facts">
            <span>
              <small>Status</small>
              <strong>Ready</strong>
            </span>
            <span>
              <small>Format</small>
              <strong>JSON</strong>
            </span>
          </div>
          <p className="form-help">{lastBackupLabel(lastBackup)}</p>
          <a className="primary" href="/api/backup" onClick={() => { markBackupDownloaded(); setLastBackup(new Date().toISOString()); }}>
            <Download size={17} aria-hidden="true" /> Download Backup
          </a>
        </article>
      </div>
      <article className="panel backup-warning">
        <strong>Store this file securely</strong>
        <p>
          The locked specification intentionally allows export only. A database
          administrator must perform any recovery operation to prevent
          accidental ledger replacement.
        </p>
      </article>
    </section>
  );
}

function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function NoticeMessage({ notice }: { notice: Exclude<Notice, undefined> }) {
  return (
    <p
      className={`notice ${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {notice.message}
    </p>
  );
}
function ErrorNotice({ message }: { message: string }) {
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  );
}
function Empty({ message }: { message: string }) {
  return (
    <div className="empty-list" role="status">
      <ReceiptText size={30} />
      <p>{message}</p>
    </div>
  );
}
function Loading({ label }: { label: string }) {
  return (
    <div className="panel empty-list" role="status">
      <TrendingUp size={30} />
      <p>{label}</p>
    </div>
  );
}
function Status({ children }: { children: string }) {
  return (
    <span
      className={`status status-${children.toLowerCase().replace("_", "-")}`}
    >
      {children.replace("_", " ")}
    </span>
  );
}
function Metric({
  icon,
  tone,
  label,
  value,
  hint,
}: {
  icon?: ReactNode;
  tone?: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className={tone ? `metric-${tone}` : ""}>
      {icon && (
        <i className="metric-icon" aria-hidden="true">
          {icon}
        </i>
      )}
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}
function PaymentMiniList({ payments }: { payments: Payment[] }) {
  return payments.length ? (
    <div className="activity-list">
      {payments.map((payment) => (
        <div key={payment.id}>
          <span>
            <strong>{payment.customerName}</strong>
            <small>
              {formatBusinessDate(payment.paymentDate)} ·{" "}
              {payment.paymentMode.toUpperCase()}
            </small>
          </span>
          <b>{formatRupees(payment.amountReceivedPaise)}</b>
        </div>
      ))}
    </div>
  ) : (
    <Empty message="No collection activity this month" />
  );
}
function TrendChart({ trends }: { trends: Report["trends"] }) {
  const max = Math.max(
    1,
    ...trends.flatMap((item) => [
      Number(item.billedPaise),
      Number(item.collectedPaise),
    ]),
  );
  return trends.length ? (
    <div
      className="trend-chart"
      role="img"
      aria-label="Monthly billed and collected comparison"
    >
      <div className="chart-legend">
        <span>
          <i className="billed" /> Billed
        </span>
        <span>
          <i className="collected" /> Collected
        </span>
      </div>
      <div className="bars">
        {trends.map((item) => (
          <div
            className="bar-group"
            key={item.month}
            title={`${item.month}: billed ${formatRupees(Number(item.billedPaise))}, collected ${formatRupees(Number(item.collectedPaise))}`}
          >
            <div
              className="bar billed"
              style={{
                height: `${Math.max(2, (Number(item.billedPaise) / max) * 100)}%`,
              }}
            />
            <div
              className="bar collected"
              style={{
                height: `${Math.max(2, (Number(item.collectedPaise) / max) * 100)}%`,
              }}
            />
            <small>{item.month.slice(5)}</small>
          </div>
        ))}
      </div>
    </div>
  ) : (
    <Empty message="No trend data yet" />
  );
}
function LedgerTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: string[];
  rows: string[][];
}) {
  return (
    <article className="panel table-panel responsive-register ledger-register">
      <h2>{title}</h2>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td data-label={headers[cellIndex]} key={cellIndex}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty message={`No ${title.toLowerCase()} entries in this range`} />
      )}
    </article>
  );
}
