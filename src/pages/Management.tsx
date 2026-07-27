import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Archive,
  Clock,
  Download,
  FileText,
  Info,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  formatRupees,
  paymentAmountAfterDiscount,
  rupeesToPaise,
} from "../lib/money";
import {
  billingCyclePosition,
  formatBusinessDate,
  formatBusinessMonth,
  todayInBusinessTimezone,
} from "../lib/date";
import {
  createArea,
  createCustomer,
  createPayment,
  createPlan,
  deleteArea,
  deleteCustomer,
  permanentlyDeleteArchivedCustomer,
  listAllInvoices,
  listAllPayments,
  listAreas,
  listCustomers,
  listPlans,
  getSettings,
  restoreCustomer,
  updateArea,
  updateCustomer,
  updatePlan,
} from "../lib/api";
import type {
  Area,
  Customer,
  Invoice,
  Payment,
  Plan,
  ServiceType,
} from "../lib/api";
import { InvoiceForm } from "../components/InvoiceForm";
import { downloadCsv } from "../lib/csv";
import { customerDueLabel, duePlanPeriodLabel } from "../lib/billing";

type Notice = { kind: "success" | "error"; message: string } | undefined;
const documents = () => import("../lib/documents");

function formatDuePeriod(customer: Customer) {
  if (!customer.oldestDuePeriodStart || !customer.latestDuePeriodEnd)
    return "No pending invoice";
  const first = formatBusinessMonth(customer.oldestDuePeriodStart);
  const last = formatBusinessMonth(customer.latestDuePeriodEnd);
  return first === last ? first : `${first} – ${last}`;
}
function formatDueStatus(customer: Customer) {
  return customerDueLabel(customer);
}
function netDue(customer: Customer) {
  return customer.amountDuePaise - customer.creditBalancePaise;
}
function accountPosition(customer: Customer) {
  const balance = netDue(customer);
  return balance > 0
    ? `${formatRupees(balance)} due`
    : balance < 0
      ? `${formatRupees(-balance)} advance`
      : "Settled";
}
function coverageLabel(customer: Customer) {
  if (!customer.latestPeriodEnd) return "Never billed";
  if (customer.coverageStatus === "future")
    return `Future from ${formatBusinessDate(customer.latestPeriodStart!)}`;
  if (customer.coverageStatus === "expiring_today") return "Expiring today";
  if (customer.coverageStatus === "expired")
    return `Expired ${formatBusinessDate(customer.latestPeriodEnd)}`;
  return `Active through ${formatBusinessDate(customer.latestPeriodEnd)}`;
}

export function PlansPage({ serviceType }: { serviceType: ServiceType }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [editing, setEditing] = useState<Plan>();
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const refresh = useCallback(() => {
    setLoading(true);
    listPlans(serviceType)
      .then(setPlans)
      .catch((error: Error) =>
        setNotice({ kind: "error", message: error.message }),
      )
      .finally(() => setLoading(false));
  }, [serviceType]);
  useEffect(() => {
    setEditing(undefined);
    setFormOpen(false);
    refresh();
  }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const values = {
        name: String(form.get("name")),
        pricePaise: rupeesToPaise(String(form.get("price"))),
        units: String(form.get("units")),
        isActive: form.get("isActive") === "on",
      };
      if (editing) await updatePlan(serviceType, { id: editing.id, ...values });
      else
        await createPlan(
          serviceType,
          values.name,
          values.pricePaise,
          values.units,
        );
      setEditing(undefined);
      setFormOpen(false);
      setNotice({
        kind: "success",
        message: editing ? "Plan updated." : "Plan saved.",
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to save plan.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function toggle(plan: Plan) {
    try {
      await updatePlan(serviceType, {
        id: plan.id,
        name: plan.name,
        pricePaise: plan.pricePaise,
        units: plan.units,
        isActive: !plan.isActive,
      });
      setNotice({
        kind: "success",
        message: `${plan.name} marked ${plan.isActive ? "inactive" : "active"}.`,
      });
      refresh();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to update plan.",
      });
    }
  }
  const openAdd = () => {
    setEditing(undefined);
    setFormOpen(true);
  };
  const openEdit = (plan: Plan) => {
    setEditing(plan);
    setFormOpen(true);
  };

  return (
    <section className="page-content">
      <PageTitle
        title="Plans"
        subtitle="Manage fixed 30-day service cycles and pricing."
        action={
          <button className="primary" onClick={openAdd}>
            <Plus size={16} /> Add Plan
          </button>
        }
      />
      {notice && <NoticeMessage notice={notice} />}
      <article className="panel table-panel register-panel plans-register">
        <div className="register-heading">
          <h2>Active Plans</h2>
          <span>{plans.length} total</span>
        </div>
        {loading ? (
          <p className="empty-inline">Loading plans…</p>
        ) : plans.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Plan Name</th>
                  <th>Price</th>
                  <th>Duration</th>
                  <th>{serviceType === "cable" ? "Units" : "Speed"}</th>
                  <th>Subscribers</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td data-label="Plan">
                      <span className="entity-cell">
                        <i aria-hidden="true">
                          <Network size={16} />
                        </i>
                        <span>
                          <strong>{plan.name}</strong>
                          <small>{plan.isActive ? "Active" : "Inactive"}</small>
                        </span>
                      </span>
                    </td>
                    <td data-label="Price">
                      <strong className="price-text">
                        {formatRupees(plan.pricePaise)}
                      </strong>
                    </td>
                    <td data-label="Duration">
                      <span className="with-icon">
                        <Clock size={14} aria-hidden="true" />
                        30 days
                      </span>
                    </td>
                    <td
                      data-label={serviceType === "cable" ? "Units" : "Speed"}
                    >
                      {plan.units || "—"}
                    </td>
                    <td data-label="Subscribers">
                      <span className="with-dot">
                        <i
                          className={plan.subscriberCount ? "live" : ""}
                          aria-hidden="true"
                        />
                        {plan.subscriberCount} active
                      </span>
                    </td>
                    <td data-label="Actions">
                      <div className="action-row">
                        <button
                          className="icon-button"
                          aria-label={`Edit ${plan.name}`}
                          title="Edit plan"
                          onClick={() => openEdit(plan)}
                        >
                          <Pencil size={15} aria-hidden="true" />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`${plan.isActive ? "Deactivate" : "Activate"} ${plan.name}`}
                          title={
                            plan.isActive ? "Deactivate plan" : "Activate plan"
                          }
                          onClick={() => void toggle(plan)}
                        >
                          {plan.isActive ? (
                            <Archive size={15} aria-hidden="true" />
                          ) : (
                            <RotateCcw size={15} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            label="No plans yet"
            text="Add your first plan to get started."
          />
        )}
      </article>
      {formOpen && (
        <Modal
          title={editing ? "Edit Plan" : "Create New Plan"}
          onClose={() => {
            setFormOpen(false);
            setEditing(undefined);
          }}
        >
          <form
            className="modal-form"
            key={editing?.id ?? "new"}
            onSubmit={submit}
          >
            <label className="full-field">
              Plan Name
              <input
                name="name"
                autoComplete="off"
                required
                maxLength={100}
                defaultValue={editing?.name}
                placeholder="e.g. Standard Cable"
              />
            </label>
            <label>
              30-Day Cycle Price (₹)
              <input
                name="price"
                autoComplete="off"
                inputMode="decimal"
                required
                pattern="\d+(\.\d{1,2})?"
                defaultValue={
                  editing ? (editing.pricePaise / 100).toFixed(2) : ""
                }
              />
            </label>
            <label>
              Fixed Cycle Length (Days)
              <input value="30" disabled aria-label="Fixed cycle length in days" />
            </label>
            <label className="full-field">
              {serviceType === "cable"
                ? "Units / Reference"
                : "Speed / Reference"}
              <input
                name="units"
                autoComplete="off"
                maxLength={120}
                defaultValue={editing?.units}
              />
            </label>
            {editing && (
              <label className="check-row full-field">
                <input
                  name="isActive"
                  type="checkbox"
                  defaultChecked={Boolean(editing.isActive)}
                />{" "}
                Available for new customers
              </label>
            )}
            <div className="modal-actions full-field">
              <button
                type="button"
                className="secondary"
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={submitting}>
                {submitting
                  ? "Saving…"
                  : editing
                    ? "Update Plan"
                    : "Create Plan"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function CustomersPage({ serviceType }: { serviceType: ServiceType }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [archivedCustomers, setArchivedCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Customer["status"]>(
    "all",
  );
  const [areaFilter, setAreaFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [dueOnly, setDueOnly] = useState(false);
  const [editing, setEditing] = useState<Customer>();
  const [editingArea, setEditingArea] = useState<Area>();
  const [deletingArea, setDeletingArea] = useState<Area>();
  const [formOpen, setFormOpen] = useState(false);
  const [summary, setSummary] = useState<Customer>();
  const [financialPopover, setFinancialPopover] = useState<{
    customer: Customer;
    left: number;
    top: number;
  }>();
  const [summaryHistory, setSummaryHistory] = useState<{
    invoices: Invoice[];
    payments: Payment[];
  }>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [quickInvoice, setQuickInvoice] = useState<Customer>();
  const [quickPayment, setQuickPayment] = useState<Customer>();
  const [paymentRequestKey, setPaymentRequestKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [deleting, setDeleting] = useState<Customer>();
  const [archiveReason, setArchiveReason] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [restoreReason, setRestoreReason] = useState("");
  const [permanentlyDeleting, setPermanentlyDeleting] = useState<Customer>();
  const [permanentDeleteReason, setPermanentDeleteReason] = useState("");
  const [updatingStatus, setUpdatingStatus] = useState<number>();
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(
    () => new Set(),
  );
  const refresh = useCallback(
    (search: string) => {
      setLoading(true);
      Promise.all([
        listAreas(serviceType),
        listPlans(serviceType),
        listCustomers(serviceType, search),
        listCustomers(serviceType, "", true),
      ])
        .then(([nextAreas, nextPlans, nextCustomers, nextArchived]) => {
          setAreas(nextAreas);
          setPlans(nextPlans);
          setCustomers(nextCustomers);
          setArchivedCustomers(nextArchived);
          const availableIds = new Set(nextCustomers.map(({ id }) => id));
          setSelectedCustomerIds(
            (selected) =>
              new Set([...selected].filter((id) => availableIds.has(id))),
          );
        })
        .catch((error: Error) =>
          setNotice({ kind: "error", message: error.message }),
        )
        .finally(() => setLoading(false));
    },
    [serviceType],
  );
  useEffect(() => {
    setQuery("");
    setEditing(undefined);
    setFormOpen(false);
    setSelectedCustomerIds(new Set());
    refresh("");
  }, [refresh]);

  const filteredCustomers = useMemo(
    () =>
      customers.filter(
        (customer) =>
          (statusFilter === "all" || customer.status === statusFilter) &&
          (areaFilter === "all" || customer.areaId === Number(areaFilter)) &&
          (planFilter === "all" ||
            (planFilter === "none"
              ? customer.planId === null
              : customer.planId === Number(planFilter))) &&
          (!dueOnly || netDue(customer) > 0),
      ),
    [areaFilter, customers, dueOnly, planFilter, statusFilter],
  );
  const allShownSelected =
    filteredCustomers.length > 0 &&
    filteredCustomers.every(({ id }) => selectedCustomerIds.has(id));
  const accountHistory = useMemo(
    () =>
      [
        ...(summaryHistory?.invoices.map((invoice) => ({
          kind: "invoice" as const,
          id: invoice.id,
          date: invoice.issuedDate,
          invoice,
        })) ?? []),
        ...(summaryHistory?.payments.map((payment) => ({
          kind: "payment" as const,
          id: payment.id,
          date: payment.paymentDate,
          payment,
        })) ?? []),
      ].sort(
        (left, right) =>
          right.date.localeCompare(left.date) ||
          (left.kind === right.kind
            ? right.id - left.id
            : left.kind === "payment"
              ? -1
              : 1),
      ),
    [summaryHistory],
  );

  function toggleCustomerSelection(customerId: number) {
    setSelectedCustomerIds((selected) => {
      const next = new Set(selected);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  }

  function toggleAllShownCustomers() {
    setSelectedCustomerIds((selected) => {
      const next = new Set(selected);
      if (allShownSelected) {
        filteredCustomers.forEach(({ id }) => next.delete(id));
      } else {
        filteredCustomers.forEach(({ id }) => next.add(id));
      }
      return next;
    });
  }

  async function saveArea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("area"));
    try {
      if (editingArea) await updateArea(serviceType, editingArea.id, value);
      else await createArea(serviceType, value);
      form.reset();
      setEditingArea(undefined);
      setNotice({ kind: "success", message: "Area saved." });
      refresh(query);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to save area.",
      });
    }
  }
  async function removeArea(area: Area) {
    setSubmitting(true);
    try {
      await deleteArea(serviceType, area.id);
      setDeletingArea(undefined);
      setNotice({ kind: "success", message: "Area deleted." });
      refresh(query);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to delete area.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function saveCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const data = new FormData(event.currentTarget);
    try {
      const common = {
        name: String(data.get("name")).trim(),
        areaId: Number(data.get("areaId")),
        phone: String(data.get("phone")).trim() || undefined,
        stbNumber: String(data.get("stbNumber")).trim() || undefined,
        planId: Number(data.get("planId")) || undefined,
        installationDate: String(data.get("installationDate")) || undefined,
      };
      if (editing)
        await updateCustomer(serviceType, {
          id: editing.id,
          ...common,
          status: data.get("status") === "inactive" ? "inactive" : "active",
          restartDate: String(data.get("restartDate") ?? "") || undefined,
          statusReason:
            String(data.get("statusReason") ?? "").trim() || undefined,
        });
      else
        await createCustomer(serviceType, {
          ...common,
          openingBalancePaise: rupeesToPaise(
            String(data.get("openingBalance") || "0"),
          ),
          openingBalanceType:
            data.get("openingBalanceType") === "advance" ? "advance" : "due",
        });
      setFormOpen(false);
      setEditing(undefined);
      setNotice({
        kind: "success",
        message: editing ? "Subscriber updated." : "Subscriber saved.",
      });
      refresh(query);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to save subscriber.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function toggleStatus(customer: Customer) {
    const nextStatus = customer.status === "active" ? "inactive" : "active";
    setUpdatingStatus(customer.id);
    try {
      await updateCustomer(serviceType, {
        id: customer.id,
        name: customer.name,
        areaId: customer.areaId,
        phone: customer.phone ?? undefined,
        stbNumber: customer.stbNumber ?? undefined,
        planId: customer.planId ?? undefined,
        installationDate: customer.installationDate ?? undefined,
        status: nextStatus,
        restartDate:
          nextStatus === "active" ? todayInBusinessTimezone() : undefined,
        statusReason: `Status changed to ${nextStatus} from subscriber directory`,
      });
      setNotice({
        kind: "success",
        message: `${customer.name} is now ${nextStatus}.`,
      });
      refresh(query);
    } catch (error) {
      setNotice({
        kind: "error",
        message: `${error instanceof Error ? error.message : "Unable to update status."} Use Edit Subscriber if a restart date is required.`,
      });
    } finally {
      setUpdatingStatus(undefined);
    }
  }
  async function archiveCustomer() {
    if (!deleting) return;
    setSubmitting(true);
    try {
      await deleteCustomer(serviceType, deleting.id, archiveReason);
      setDeleting(undefined);
      setArchiveReason("");
      setNotice({
        kind: "success",
        message: "Subscriber archived. Financial history was retained.",
      });
      refresh(query);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to archive subscriber.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function collectQuickPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quickPayment) return;
    setSubmitting(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await createPayment(serviceType, {
        customerId: quickPayment.id,
        paymentDate: String(data.get("paymentDate")),
        amountReceivedPaise: rupeesToPaise(String(data.get("amount"))),
        discountGivenPaise: rupeesToPaise(String(data.get("discount") || "0")),
        paymentMode: data.get("paymentMode") === "upi" ? "upi" : "cash",
        paymentReference: String(data.get("paymentReference") || "").trim() || undefined,
        notes: String(data.get("notes") || "") || undefined,
        requestKey: paymentRequestKey,
      });
      setPaymentRequestKey(crypto.randomUUID());
      setQuickPayment(undefined);
      setNotice({
        kind: "success",
        message: `${result.paymentCode} recorded for ${quickPayment.name}.`,
      });
      refresh(query);
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
  const openAdd = () => {
    setNotice(undefined);
    setEditing(undefined);
    setFormOpen(true);
  };
  const openEdit = (customer: Customer) => {
    setNotice(undefined);
    setEditing(customer);
    setFormOpen(true);
  };
  const openPayment = (customer: Customer) => {
    setPaymentRequestKey(crypto.randomUUID());
    setQuickPayment(customer);
  };
  async function restoreArchived(customer: Customer) {
    setSubmitting(true);
    try {
      await restoreCustomer(serviceType, customer.id, restoreReason);
      setRestoreReason("");
      setNotice({ kind: "success", message: `${customer.name} restored.` });
      refresh(query);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to restore subscriber.",
      });
    } finally {
      setSubmitting(false);
    }
  }
  async function permanentlyDeleteArchived() {
    if (!permanentlyDeleting) return;
    setSubmitting(true);
    try {
      await permanentlyDeleteArchivedCustomer(serviceType, permanentlyDeleting.id, permanentDeleteReason);
      setNotice({ kind: "success", message: `${permanentlyDeleting.name} was permanently removed because it has no billing history.` });
      setPermanentlyDeleting(undefined);
      setPermanentDeleteReason("");
      refresh(query);
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Unable to permanently delete subscriber." });
    } finally {
      setSubmitting(false);
    }
  }
  function exportSubscribers() {
    const exportCustomers = selectedCustomerIds.size
      ? customers.filter(({ id }) => selectedCustomerIds.has(id))
      : filteredCustomers;
    downloadCsv(
      `${serviceType}-subscribers.csv`,
      exportCustomers.map((customer) => ({
        Code: customer.customerCode,
        Name: customer.name,
        Phone: customer.phone ?? "",
        STB: customer.stbNumber ?? "",
        Area: customer.areaName,
        Plan: customer.planName ?? "",
        Payment: accountPosition(customer),
        Service: coverageLabel(customer),
        "Next Bill": customer.nextBillingStartDate ?? "",
        Status: customer.status,
      })),
    );
  }
  const openSummary = (customer: Customer) => {
    setSummary(customer);
    setSummaryHistory(undefined);
    setSummaryLoading(true);
    Promise.all([
      listAllInvoices(serviceType, customer.customerCode),
      listAllPayments(serviceType, { query: customer.customerCode }),
    ])
      .then(([invoices, payments]) =>
        setSummaryHistory({
          invoices,
          payments,
        }),
      )
      .catch((error: Error) =>
        setNotice({
          kind: "error",
          message: `Unable to load subscriber history: ${error.message}`,
        }),
      )
      .finally(() => setSummaryLoading(false));
  };
  async function shareStatement() {
    if (!summary || !summaryHistory) return;
    setSubmitting(true);
    try {
      const settings = await getSettings();
      if (!settings) throw new Error("Complete business settings before sharing a statement.");
      await documents().then(({ shareStatement: share }) =>
        share(summary, summaryHistory.invoices, summaryHistory.payments, settings),
      );
      setNotice({ kind: "success", message: `Statement prepared for ${summary.name}.` });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Unable to share statement." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page-content">
      <PageTitle
        title="Subscribers"
        subtitle="Manage subscriber status, 30-day coverage, billing, and collections."
        action={
          <div className="page-actions subscriber-page-actions">
            <button className="secondary" onClick={exportSubscribers}>
              <Download size={16} />
              {selectedCustomerIds.size
                ? `Export Selected (${selectedCustomerIds.size})`
                : "Export"}
            </button>
            <button className="secondary" onClick={() => setArchivedOpen(true)}>
              <Archive size={16} /> Archived ({archivedCustomers.length})
            </button>
            <button className="primary" onClick={openAdd}>
              <Plus size={16} /> Add Subscriber
            </button>
          </div>
        }
      />
      {notice && <NoticeMessage notice={notice} />}
      <article className="panel customer-filters">
        <div className="search-row">
          <Search size={17} />
          <input
            name="subscriberSearch"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") refresh(query);
            }}
            placeholder="Search by name, ID, phone, STB, or area…"
            aria-label="Search subscribers"
          />
          <button className="secondary" onClick={() => refresh(query)}>
            Search
          </button>
        </div>
        <div className="customer-filter-grid">
          <label className="due-toggle">
            <input
              type="checkbox"
              checked={dueOnly}
              onChange={(event) => setDueOnly(event.target.checked)}
            />
            <span>Pending Due Only</span>
          </label>
          <label>
            <span className="sr-only">Status</span>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
            >
              <option value="all">Status: All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Area</span>
            <select
              value={areaFilter}
              onChange={(event) => setAreaFilter(event.target.value)}
            >
              <option value="all">Area: All</option>
              {areas.map((area) => (
                <option value={area.id} key={area.id}>
                  {area.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Plan</span>
            <select
              value={planFilter}
              onChange={(event) => setPlanFilter(event.target.value)}
            >
              <option value="all">Plan: All</option>
              <option value="none">No plan</option>
              {plans.map((plan) => (
                <option value={plan.id} key={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </article>
      <article className="panel table-panel register-panel customer-register">
        <div className="register-heading">
          <h2>Subscriber Directory</h2>
          <span>
            {selectedCustomerIds.size
              ? `${selectedCustomerIds.size} selected`
              : `${filteredCustomers.length} shown`}
          </span>
        </div>
        {loading ? (
          <p className="empty-inline">Loading subscribers…</p>
        ) : filteredCustomers.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="subscriber-select-column">
                    <input
                      className="subscriber-checkbox"
                      type="checkbox"
                      checked={allShownSelected}
                      onChange={toggleAllShownCustomers}
                      aria-label="Select all shown subscribers"
                    />
                  </th>
                  <th className="subscriber-number-column">No.</th>
                  <th>Subscriber</th>
                  <th>STB / Area</th>
                  <th>Plan & Balance</th>
                  <th>Billing</th>
                  <th>Status</th>
                  <th aria-label="Actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((customer) => {
                  const canInvoice =
                    customer.status === "active" &&
                    Boolean(
                      customer.planId &&
                      customer.planIsActive &&
                      customer.installationDate &&
                      customer.nextBillingStartDate,
                    );
                  return (
                    <tr
                      key={customer.id}
                      className={
                        selectedCustomerIds.has(customer.id) ? "selected" : ""
                      }
                    >
                      <td
                        className="subscriber-select-column"
                        data-label="Select"
                      >
                        <input
                          className="subscriber-checkbox"
                          type="checkbox"
                          checked={selectedCustomerIds.has(customer.id)}
                          onChange={() => toggleCustomerSelection(customer.id)}
                          aria-label={`Select ${customer.name}`}
                        />
                      </td>
                      <td
                        className="subscriber-number-column"
                        data-label="No."
                      >
                        <span
                          className="subscriber-number"
                          title={customer.customerCode}
                        >
                          {customer.sortOrder}
                        </span>
                      </td>
                      <td data-label="Subscriber">
                        <span className="entity-cell">
                          <i className="avatar" aria-hidden="true">
                            {customer.name.slice(0, 1).toUpperCase()}
                          </i>
                          <span>
                            <strong>{customer.name}</strong>
                            <small>
                              {customer.customerCode}
                              {customer.phone ? ` · ${customer.phone}` : ""}
                            </small>
                          </span>
                        </span>
                      </td>
                      <td data-label="STB / Area">
                        <strong>{customer.stbNumber || "N/A"}</strong>
                        <small>{customer.areaName}</small>
                      </td>
                      <td data-label="Plan & Balance">
                        <strong>{customer.planName || "No plan"}</strong>
                        <small
                          className={
                            netDue(customer) > 0
                              ? "amount-due"
                              : netDue(customer) < 0
                                ? "amount-credit"
                                : ""
                          }
                        >
                          {accountPosition(customer)}
                        </small>
                      </td>
                      <td data-label="Billing">
                        <div className="subscriber-billing-cell">
                          <button
                            className="icon-button info-button"
                            aria-label={`View financial summary for ${customer.name}`}
                            title="Financial summary"
                            aria-expanded={
                              financialPopover?.customer.id === customer.id
                            }
                            onClick={(event) => {
                              const bounds =
                                event.currentTarget.getBoundingClientRect();
                              setFinancialPopover((current) =>
                                current?.customer.id === customer.id
                                  ? undefined
                                  : {
                                      customer,
                                      left: Math.min(
                                        Math.max(12, bounds.left - 8),
                                        window.innerWidth - 348,
                                      ),
                                      top: Math.min(
                                        bounds.bottom + 8,
                                        window.innerHeight - 250,
                                      ),
                                    },
                              );
                            }}
                          >
                            <Info size={15} aria-hidden="true" />
                          </button>
                          {netDue(customer) > 0 ? (
                            <span
                              className="due-period"
                              title="Outstanding invoice period"
                            >
                              {formatDueStatus(customer)}
                            </span>
                          ) : null}
                        </div>
                        <small
                          className={`coverage-label ${customer.coverageStatus}`}
                        >
                          {coverageLabel(customer)}
                        </small>
                        <small>
                          Next bill:{" "}
                          {customer.nextBillingStartDate
                            ? formatBusinessDate(customer.nextBillingStartDate)
                            : "Not configured"}
                        </small>
                        {customer.hasHistoricalGap ? (
                          <small className="amount-due">
                            Historical billing gap detected
                          </small>
                        ) : null}
                      </td>
                      <td data-label="Status">
                        <button
                          className={`status-toggle ${customer.status}`}
                          role="switch"
                          aria-checked={customer.status === "active"}
                          aria-label={`${customer.name} is ${customer.status}. Switch to ${customer.status === "active" ? "inactive" : "active"}.`}
                          disabled={updatingStatus === customer.id}
                          onClick={() => void toggleStatus(customer)}
                        >
                          <i aria-hidden="true" />
                          {updatingStatus === customer.id
                            ? "Updating…"
                            : customer.status}
                        </button>
                      </td>
                      <td data-label="Actions">
                        <div className="action-row customer-actions">
                          <button
                            className="icon-button"
                            aria-label={`View account history for ${customer.name}`}
                            title="Account history"
                            onClick={() => openSummary(customer)}
                          >
                            <Clock size={16} aria-hidden="true" />
                          </button>
                          <button
                            className="icon-button action-invoice"
                            aria-label={`Create invoice for ${customer.name}`}
                            title={
                              canInvoice
                                ? "Create invoice"
                                : "Active plan and installation date required"
                            }
                            disabled={!canInvoice}
                            onClick={() => setQuickInvoice(customer)}
                          >
                            <FileText size={16} aria-hidden="true" />
                          </button>
                          <button
                            className="icon-button action-payment"
                            aria-label={`Record payment for ${customer.name}`}
                            title="Record payment"
                            onClick={() => openPayment(customer)}
                          >
                            <Wallet size={16} aria-hidden="true" />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Edit ${customer.name}`}
                            title="Edit subscriber"
                            onClick={() => openEdit(customer)}
                          >
                            <Pencil size={16} aria-hidden="true" />
                          </button>
                          <button
                            className="icon-button danger"
                            aria-label={`Archive ${customer.name}`}
                            title="Archive subscriber"
                            onClick={() => {
                              setArchiveReason("");
                              setDeleting(customer);
                            }}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            label="No subscribers found"
            text="Change the filters or add a subscriber."
          />
        )}
      </article>

      {financialPopover ? (
        <div
          className="financial-popover-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setFinancialPopover(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFinancialPopover(undefined);
          }}
        >
          <section
            className="financial-popover"
            role="dialog"
            aria-label={`Financial summary for ${financialPopover.customer.name}`}
            style={{
              left: financialPopover.left,
              top: financialPopover.top,
            }}
          >
            <header>
              <span>
                <Wallet size={17} aria-hidden="true" /> Financial Summary
              </span>
              <button
                className="icon-button"
                autoFocus
                aria-label="Close financial summary"
                onClick={() => setFinancialPopover(undefined)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <dl>
              {financialPopover.customer.previousDuePaise > 0 ? (
                <div>
                  <dt>Previous Due</dt>
                  <dd className="amount-due">
                    {formatRupees(
                      financialPopover.customer.previousDuePaise,
                    )}
                  </dd>
                </div>
              ) : null}
              {financialPopover.customer.currentPlanDuePaise > 0 ||
              financialPopover.customer.futurePlanDuePaise > 0 ? (
                <div>
                  <dt>
                    Plan Dues
                    <small>
                      {duePlanPeriodLabel(
                        financialPopover.customer.duePlanPeriodStart,
                        financialPopover.customer.duePlanCycleEndStart,
                      )}
                    </small>
                  </dt>
                  <dd className="amount-due">
                    {formatRupees(
                      financialPopover.customer.currentPlanDuePaise +
                        financialPopover.customer.futurePlanDuePaise,
                    )}
                  </dd>
                </div>
              ) : null}
              <div className="popover-net">
                <dt>Net Balance</dt>
                <dd
                  className={
                    netDue(financialPopover.customer) > 0
                      ? "amount-due"
                      : netDue(financialPopover.customer) < 0
                        ? "amount-credit"
                        : ""
                  }
                >
                  {accountPosition(financialPopover.customer)}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      ) : null}

      {formOpen && (
        <Modal
          title={editing ? `Edit ${editing.customerCode}` : "Add Subscriber"}
          wide
          compact
          onClose={() => {
            setFormOpen(false);
            setEditing(undefined);
          }}
        >
          <form
            className="inline-form area-form"
            key={editingArea?.id ?? "new-area"}
            onSubmit={saveArea}
          >
            <input
              name="area"
              autoComplete="off"
              required
              maxLength={120}
              defaultValue={editingArea?.displayName}
              aria-label={editingArea ? "Area name" : "New area name"}
              placeholder="Add a new area…"
            />
            <button type="submit" className="secondary">
              {editingArea ? "Update" : "Add Area"}
            </button>
          </form>
          {areas.length > 0 && (
            <div className="area-chips" aria-label="Service areas">
              {areas.map((area) => (
                <span key={area.id}>
                  {area.displayName}
                  <button
                    type="button"
                    aria-label={`Edit ${area.displayName}`}
                    onClick={() => setEditingArea(area)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${area.displayName}`}
                    onClick={() => {
                      setFormOpen(false);
                      setEditing(undefined);
                      setEditingArea(undefined);
                      setDeletingArea(area);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            className="modal-form customer-form"
            key={editing?.id ?? "new"}
            onSubmit={saveCustomer}
          >
            <label>
              Name *
              <input
                name="name"
                autoComplete="name"
                required
                maxLength={160}
                defaultValue={editing?.name}
              />
            </label>
            <label>
              Area *
              <select
                name="areaId"
                required
                defaultValue={editing?.areaId ?? ""}
              >
                <option value="" disabled>
                  Select area
                </option>
                {areas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Phone
              <input
                name="phone"
                type="tel"
                autoComplete="tel"
                maxLength={30}
                defaultValue={editing?.phone ?? ""}
              />
            </label>
            <label>
              STB Number
              <input
                name="stbNumber"
                autoComplete="off"
                spellCheck={false}
                maxLength={80}
                defaultValue={editing?.stbNumber ?? ""}
              />
            </label>
            <label>
              Plan
              <select name="planId" defaultValue={editing?.planId ?? ""}>
                <option value="">No plan yet</option>
                {plans
                  .filter(
                    (plan) => plan.isActive || plan.id === editing?.planId,
                  )
                  .map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} — {formatRupees(plan.pricePaise)}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Installation Date
              <input
                name="installationDate"
                type="date"
                defaultValue={editing?.installationDate ?? ""}
              />
            </label>
            {editing ? (
              <>
                <label>
                  Status
                  <select name="status" defaultValue={editing.status}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
                {editing.status === "inactive" ? (
                  <label>
                    Restart Date
                    <input
                      name="restartDate"
                      type="date"
                      defaultValue={todayInBusinessTimezone()}
                    />
                  </label>
                ) : null}
                <label className="full-field">
                  Change Reason
                  <input
                    name="statusReason"
                    maxLength={250}
                    placeholder="Required when changing service status"
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Opening Balance
                  <input
                    name="openingBalance"
                    autoComplete="off"
                    inputMode="decimal"
                    defaultValue="0"
                    pattern="\d+(\.\d{1,2})?"
                  />
                </label>
                <label>
                  Balance Type
                  <select name="openingBalanceType" defaultValue="due">
                    <option value="due">Due (Dr)</option>
                    <option value="advance">Advance (Cr)</option>
                  </select>
                </label>
              </>
            )}
            {notice?.kind === "error" ? (
              <div className="full-field">
                <NoticeMessage notice={notice} />
              </div>
            ) : null}
            <div className="modal-actions full-field">
              <button
                type="button"
                className="secondary"
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={submitting || !areas.length}
              >
                <Users size={16} />{" "}
                {submitting
                  ? "Saving…"
                  : editing
                    ? "Update Subscriber"
                    : "Add Subscriber"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {summary && (
        <Modal
          title="Financial Summary & History"
          wide
          onClose={() => setSummary(undefined)}
        >
          <div className="financial-summary">
            <div className="summary-customer">
              <i>{summary.name.slice(0, 1).toUpperCase()}</i>
              <span>
                <strong>{summary.name}</strong>
                <small>
                  {summary.customerCode} · {summary.planName || "No plan"}
                </small>
              </span>
            </div>
            <dl>
              <div>
                <dt>Service coverage</dt>
                <dd>{coverageLabel(summary)}</dd>
              </div>
              <div>
                <dt>Next valid billing start</dt>
                <dd>
                  {summary.nextBillingStartDate
                    ? formatBusinessDate(summary.nextBillingStartDate)
                    : "Not configured"}
                </dd>
              </div>
              <div>
                <dt>Pending invoice period</dt>
                <dd>{formatDuePeriod(summary)}</dd>
              </div>
              <div>
                <dt>Open invoices</dt>
                <dd>{summary.openInvoiceCount}</dd>
              </div>
              <div>
                <dt>Previous due</dt>
                <dd className={summary.previousDuePaise > 0 ? "amount-due" : ""}>
                  {formatRupees(summary.previousDuePaise)}
                </dd>
              </div>
              <div>
                <dt>Current cycle due</dt>
                <dd className={summary.currentPlanDuePaise > 0 ? "amount-due" : ""}>
                  {formatRupees(summary.currentPlanDuePaise)}
                </dd>
              </div>
              <div>
                <dt>Next / future cycle due</dt>
                <dd className={summary.futurePlanDuePaise > 0 ? "amount-due" : ""}>
                  {formatRupees(summary.futurePlanDuePaise)}
                </dd>
              </div>
              <div>
                <dt>Advance credit</dt>
                <dd
                  className={
                    summary.creditBalancePaise > 0 ? "amount-credit" : ""
                  }
                >
                  {formatRupees(summary.creditBalancePaise)}
                </dd>
              </div>
              <div className="summary-net">
                <dt>Net account position</dt>
                <dd
                  className={
                    netDue(summary) > 0
                      ? "amount-due"
                      : netDue(summary) < 0
                        ? "amount-credit"
                        : ""
                  }
                >
                  {accountPosition(summary)}
                </dd>
              </div>
            </dl>
            <div className="customer-history">
              <div className="history-heading">
                <span>
                  <h3>Account history</h3>
                  <small>Invoices and payments, including the current cycle</small>
                </span>
                <strong>{accountHistory.length} entries</strong>
              </div>
              {summaryLoading ? (
                <p className="empty-inline">Loading history…</p>
              ) : accountHistory.length ? (
                <div className="history-ledger" role="list" aria-label="Account transactions, newest first">
                  {accountHistory.map((entry) =>
                    entry.kind === "invoice" ? (
                      <article className="ledger-entry invoice" role="listitem" key={`invoice-${entry.id}`}>
                        <div className="ledger-primary">
                          <strong className="amount-due">−{formatRupees(entry.invoice.chargeAmountPaise)}</strong>
                          <small>Invoice · {entry.invoice.status}</small>
                        </div>
                        <div className="ledger-reference">
                          <time dateTime={entry.invoice.issuedDate}>{formatBusinessDate(entry.invoice.issuedDate)}</time>
                          <small>#{entry.invoice.invoiceCode}</small>
                        </div>
                        <div className="ledger-details">
                          <span>{formatBusinessDate(entry.invoice.periodStart)} – {formatBusinessDate(entry.invoice.periodEnd)}</span>
                          <strong>{billingCyclePosition(entry.invoice.periodStart, entry.invoice.periodEnd)}</strong>
                          {entry.invoice.chargeAmountPaise > entry.invoice.currentPeriodAmountPaise ? (
                            <span>Previous due {formatRupees(entry.invoice.chargeAmountPaise - entry.invoice.currentPeriodAmountPaise)} · Plan {formatRupees(entry.invoice.currentPeriodAmountPaise)}</span>
                          ) : (
                            <span>Plan charge {formatRupees(entry.invoice.currentPeriodAmountPaise)}</span>
                          )}
                        </div>
                      </article>
                    ) : (
                      <article className="ledger-entry payment" role="listitem" key={`payment-${entry.id}`}>
                        <div className="ledger-primary">
                          <strong className="amount-credit">+{formatRupees(entry.payment.settledAmountPaise)}</strong>
                          <small>Payment · {entry.payment.paymentMode.replace("_", " ")}</small>
                        </div>
                        <div className="ledger-reference">
                          <time dateTime={entry.payment.paymentDate}>{formatBusinessDate(entry.payment.paymentDate)}</time>
                          <small>#{entry.payment.paymentCode}</small>
                        </div>
                        <div className="ledger-details">
                          <span>Received {formatRupees(entry.payment.amountReceivedPaise)}</span>
                          {entry.payment.paymentReference ? <span>Reference {entry.payment.paymentReference}</span> : null}
                          {entry.payment.discountGivenPaise > 0 ? <span>Discount {formatRupees(entry.payment.discountGivenPaise)}</span> : null}
                          {entry.payment.allocations?.map((allocation) => {
                            const amount = allocation.cashPaise + allocation.discountPaise + allocation.creditPaise
                            return <span key={`${allocation.invoiceCode}-${allocation.chargeType}`}>{allocation.chargeType === "opening_due" ? "Previous due" : "Service charge"} · {formatRupees(amount)} ({allocation.invoiceCode})</span>
                          })}
                          <strong>{entry.payment.resultingStatus.replace("_", " ")}</strong>
                        </div>
                      </article>
                    ),
                  )}
                </div>
              ) : (
                <p className="empty-inline">No invoices or payments recorded.</p>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                disabled={submitting || summaryLoading || !summaryHistory}
                onClick={() => void shareStatement()}
              >
                <FileText size={16} /> Share Statement
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setSummary(undefined);
                  openEdit(summary);
                }}
              >
                Edit Subscriber
              </button>
              {netDue(summary) > 0 ? (
                <button
                  className="primary"
                  onClick={() => {
                    setSummary(undefined);
                    openPayment(summary);
                  }}
                >
                  <Wallet size={16} /> Record Payment
                </button>
              ) : null}
            </div>
          </div>
        </Modal>
      )}
      {quickInvoice && (
        <Modal
          title="Generate Invoice"
          onClose={() => setQuickInvoice(undefined)}
        >
          <InvoiceForm
            serviceType={serviceType}
            customers={customers}
            initialCustomerId={quickInvoice.id}
            onCancel={() => setQuickInvoice(undefined)}
            onCreated={(result) => {
              setQuickInvoice(undefined);
              setNotice({
                kind: "success",
                message: `${result.invoiceCode} ${result.replayed ? "already existed" : "created"} for ${quickInvoice.name}. Coverage: ${formatBusinessDate(result.periodStart)} to ${formatBusinessDate(result.periodEnd)}.`,
              });
              refresh(query);
            }}
          />
        </Modal>
      )}
      {quickPayment && (
        <Modal
          title="Record Payment"
          onClose={() => setQuickPayment(undefined)}
        >
          <form className="modal-form" onSubmit={collectQuickPayment}>
            <div className="quick-action-context full-field">
              <Wallet size={18} />
              <span>
                <strong>{quickPayment.name}</strong>
                <small>
                  Outstanding {formatRupees(quickPayment.amountDuePaise)} ·
                  Credit {formatRupees(quickPayment.creditBalancePaise)} · Cash
                  due{" "}
                  {formatRupees(
                    Math.max(
                      0,
                      quickPayment.amountDuePaise -
                        quickPayment.creditBalancePaise,
                    ),
                  )}
                </small>
              </span>
            </div>
            {quickPayment.unbilledOpeningDuePaise > 0 ? (
              <p className="form-help full-field">
                {formatRupees(quickPayment.unbilledOpeningDuePaise)} is an opening previous due that is not attached to an invoice yet. A Cash/UPI payment recorded now is held as advance credit and automatically applied when the first invoice is generated. Generate that invoice first if a discount is required.
              </p>
            ) : null}
            <label>
              Payment Date
              <input
                name="paymentDate"
                type="date"
                max={todayInBusinessTimezone()}
                defaultValue={todayInBusinessTimezone()}
                required
              />
            </label>
            <label>
              Mode
              <select name="paymentMode" defaultValue="cash">
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
              </select>
            </label>
            <label>
              Amount Received (₹)
              <input
                name="amount"
                autoComplete="off"
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
                defaultValue={
                  Math.max(
                    0,
                    quickPayment.amountDuePaise -
                      quickPayment.creditBalancePaise,
                  )
                    ? (
                        Math.max(
                          0,
                          quickPayment.amountDuePaise -
                            quickPayment.creditBalancePaise,
                        ) / 100
                      ).toFixed(2)
                    : ""
                }
                required
              />
            </label>
            <label>
              Discount (₹)
              <input
                name="discount"
                autoComplete="off"
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
                defaultValue="0"
                required
                disabled={quickPayment.unbilledOpeningDuePaise > 0}
                onChange={(event) => {
                  const amount =
                    event.currentTarget.form?.elements.namedItem("amount");
                  if (amount instanceof HTMLInputElement)
                    amount.value = paymentAmountAfterDiscount(
                      Math.max(
                        0,
                        quickPayment.amountDuePaise -
                          quickPayment.creditBalancePaise,
                      ),
                      event.currentTarget.value,
                    );
                }}
              />
            </label>
            <p className="form-help full-field">
              The discount reduces the amount received and settles invoice dues
              only. It never creates advance credit.
            </p>
            <label className="full-field">
              UTR / Payment Reference
              <input
                name="paymentReference"
                autoComplete="off"
                maxLength={120}
                placeholder="Recommended for UPI or bank transfer"
              />
            </label>
            <p className="form-help full-field">
              The admin confirms the payment. A repeated UTR is blocked to prevent double entry.
            </p>
            <label className="full-field">
              Notes
              <input
                name="notes"
                autoComplete="off"
                maxLength={500}
                placeholder="Optional collection note…"
              />
            </label>
            <div className="modal-actions full-field">
              <button
                type="button"
                className="secondary"
                onClick={() => setQuickPayment(undefined)}
              >
                Cancel
              </button>
              <button className="primary" disabled={submitting}>
                {submitting ? "Recording…" : "Record Payment"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Archive Subscriber"
          onClose={() => setDeleting(undefined)}
        >
          <div className="confirm-content">
            <span className="confirm-icon">
              <Trash2 size={20} />
            </span>
            <div>
              <h3>Archive {deleting.name}?</h3>
              <p>
                Future billing will stop. Financial history remains available.
                Current account position: {accountPosition(deleting)}.
              </p>
              <label>
                Archive Note (optional)
                <textarea
                  value={archiveReason}
                  onChange={(event) => setArchiveReason(event.target.value)}
                  maxLength={250}
                  placeholder="Add a note only if useful"
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
                disabled={submitting}
                onClick={() => void archiveCustomer()}
              >
                {submitting ? "Archiving…" : "Archive Subscriber"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {archivedOpen && (
        <Modal
          title="Archived Subscribers"
          wide
          onClose={() => setArchivedOpen(false)}
        >
          <div className="archived-list">
            <div className="archived-intro" role="note">
              <Archive size={18} aria-hidden="true" />
              <div>
                <strong>Archived records are preserved</strong>
                <p>Invoices, payments, and balances stay available. Restore a subscriber before billing or collecting again.</p>
              </div>
            </div>
            <label>
              Restore Note (optional)
              <textarea
                value={restoreReason}
                onChange={(event) => setRestoreReason(event.target.value)}
                maxLength={250}
                placeholder="Add a note only if useful"
              />
            </label>
            {archivedCustomers.length ? (
              archivedCustomers.map((customer) => (
                <article className="archived-customer-card" key={customer.id}>
                  <div className="archived-customer-heading">
                    <span className="archived-customer-identity">
                      <i aria-hidden="true">{customer.name.slice(0, 1).toUpperCase()}</i>
                      <span>
                        <strong>{customer.name}</strong>
                        <small>{customer.customerCode} · {customer.phone || "No phone"}</small>
                      </span>
                    </span>
                    <span className="archived-status">Archived</span>
                  </div>
                  <div className="archived-customer-meta">
                    <span><small>Plan</small><strong>{customer.planName || "No plan"}</strong></span>
                    <span><small>Area</small><strong>{customer.areaName}</strong></span>
                    <span><small>Balance</small><strong className={netDue(customer) > 0 ? "amount-due" : netDue(customer) < 0 ? "amount-credit" : ""}>{accountPosition(customer)}</strong></span>
                  </div>
                  <div className="archived-customer-actions">
                    <small>Financial history retained</small>
                    <button
                      className="secondary"
                      disabled={submitting}
                      aria-busy={submitting}
                      onClick={() => void restoreArchived(customer)}
                    >
                      <RotateCcw size={15} aria-hidden="true" /> {submitting ? "Restoring…" : "Restore Subscriber"}
                    </button>
                    <button
                      className="danger-button"
                      disabled={submitting}
                      onClick={() => { setPermanentDeleteReason(""); setPermanentlyDeleting(customer); }}
                    >
                      <Trash2 size={15} aria-hidden="true" /> Permanently Delete
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <Empty
                label="No archived subscribers"
                text="Archived subscribers will appear here."
              />
            )}
          </div>
        </Modal>
      )}
      {permanentlyDeleting && (
        <Modal title="Permanently Delete Subscriber" onClose={() => setPermanentlyDeleting(undefined)}>
          <div className="confirm-content permanent-delete-content">
            <div className="danger-callout" role="alert">
              <Trash2 size={20} aria-hidden="true" />
              <div><strong>This cannot be undone.</strong><p>This action is available only when there are no active invoices or payments. An opening previous due by itself is allowed; previously deleted test records are permanently purged with this customer.</p></div>
            </div>
            <p><strong>{permanentlyDeleting.name}</strong> ({permanentlyDeleting.customerCode})</p>
            <label>Deletion note (optional)<textarea value={permanentDeleteReason} onChange={(event) => setPermanentDeleteReason(event.target.value)} maxLength={250} placeholder="Why is this archived test record being removed?" /></label>
            <div className="modal-actions"><button className="secondary" onClick={() => setPermanentlyDeleting(undefined)}>Cancel</button><button className="danger-button" disabled={submitting} onClick={() => void permanentlyDeleteArchived()}><Trash2 size={15} aria-hidden="true" /> {submitting ? "Deleting..." : "Permanently Delete"}</button></div>
          </div>
        </Modal>
      )}
      {deletingArea && (
        <Modal title="Delete Area" onClose={() => setDeletingArea(undefined)}>
          <div className="confirm-content">
            <span className="confirm-icon">
              <Trash2 size={20} aria-hidden="true" />
            </span>
            <div>
              <h3>Delete {deletingArea.displayName}?</h3>
              <p>
                This succeeds only when no current or archived subscriber
                references the area. Otherwise, reassign those subscribers
                first.
              </p>
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setDeletingArea(undefined)}
              >
                Cancel
              </button>
              <button
                className="primary danger-button"
                disabled={submitting}
                onClick={() => void removeArea(deletingArea)}
              >
                {submitting ? "Deleting…" : "Delete Area"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Modal({
  title,
  onClose,
  wide,
  compact,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  compact?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]",
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`${wide ? "modal modal-wide" : "modal"}${compact ? " modal-compact" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="management-modal-title"
      >
        <div className="modal-heading">
          <h2 id="management-modal-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
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
function Empty({ label, text }: { label: string; text: string }) {
  return (
    <div className="empty-list">
      <Users size={28} />
      <p>{label}</p>
      <small>{text}</small>
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
