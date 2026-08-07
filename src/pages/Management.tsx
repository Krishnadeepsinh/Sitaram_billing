import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronRight,
  Clock,
  Download,
  FileText,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  formatRupees,
  rupeesToPaise,
} from "../lib/money";
import { PaymentAmountFields } from "../components/PaymentAmountFields";
import { Modal } from "../components/Modal";
import {
  addBillingDays,
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
  archiveCustomers,
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
import { useDebouncedValue } from "../lib/hooks";

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
function canRecharge(customer: Customer) {
  return (
    customer.status === "active" &&
    Boolean(
      customer.planId &&
      customer.planIsActive &&
      customer.installationDate &&
      customer.nextBillingStartDate,
    )
  );
}
function hasProtectedServicePeriod(customer: Customer) {
  return (
    customer.coverageStatus === "active" ||
    customer.coverageStatus === "expiring_today" ||
    customer.coverageStatus === "future"
  );
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
  if (customer.serviceStatus === "suspended") return "Service suspended by admin";
  if (!customer.latestPeriodEnd) return "Service not started";
  if (customer.coverageStatus === "future")
    return `Service inactive · starts ${formatBusinessDate(customer.latestPeriodStart!)}`;
  if (customer.coverageStatus === "expiring_today") return "Service active today · renew by tomorrow";
  if (customer.coverageStatus === "expired")
    return `Service inactive · recharge due since ${formatBusinessDate(addBillingDays(customer.latestPeriodEnd, 1))}`;
  return `Service active through ${formatBusinessDate(customer.latestPeriodEnd)}`;
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
      <article className="panel table-panel responsive-register register-panel plans-register">
        <div className="register-heading">
          <h2>Active Plans</h2>
          <span>{plans.length} total</span>
        </div>
        {loading ? (
          <p className="empty-inline loading-inline" role="status">Loading plans…</p>
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
            <div className="modal-form-body">
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
            </div>
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

export function AreasPage({ serviceType }: { serviceType: ServiceType }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [editing, setEditing] = useState<Area>();
  const [deleting, setDeleting] = useState<Area>();
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    listAreas(serviceType)
      .then(setAreas)
      .catch((error: Error) => setNotice({ kind: "error", message: error.message }))
      .finally(() => setLoading(false));
  }, [serviceType]);

  useEffect(() => {
    setEditing(undefined);
    setDeleting(undefined);
    setFormOpen(false);
    refresh();
  }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "").trim();
    if (!displayName) {
      setNotice({ kind: "error", message: "Enter an area name first." });
      return;
    }
    setSubmitting(true);
    try {
      if (editing) await updateArea(serviceType, editing.id, displayName);
      else await createArea(serviceType, displayName);
      setEditing(undefined);
      setFormOpen(false);
      setNotice({ kind: "success", message: editing ? "Area updated." : "Area added." });
      refresh();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Unable to save area." });
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(area: Area) {
    setSubmitting(true);
    try {
      await deleteArea(serviceType, area.id);
      setDeleting(undefined);
      setNotice({ kind: "success", message: `${area.displayName} removed.` });
      refresh();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Unable to remove area." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page-content areas-page">
      <PageTitle
        title="Areas"
        subtitle="Add and manage the service areas used for subscribers."
        action={<button className="primary" onClick={() => { setEditing(undefined); setFormOpen(true); }}><Plus size={16} aria-hidden="true" /> Add Area</button>}
      />
      {notice && <NoticeMessage notice={notice} />}
      <article className="panel areas-panel">
        <div className="register-heading">
          <div><h2>Service Areas</h2><p className="panel-help">Choose an area when adding a subscriber.</p></div>
          <span>{areas.length} {areas.length === 1 ? "area" : "areas"}</span>
        </div>
        {loading ? <p className="empty-inline loading-inline" role="status">Loading areas…</p> : areas.length ? (
          <div className="areas-list" aria-label="Service areas">
            {areas.map((area) => <div className="area-row" key={area.id}>
              <div className="area-row-name"><span className="area-row-icon" aria-hidden="true"><Network size={16} /></span><strong>{area.displayName}</strong></div>
              <div className="area-row-actions">
                <button className="secondary" onClick={() => { setEditing(area); setFormOpen(true); }}><Pencil size={15} aria-hidden="true" /> Edit</button>
                <button className="secondary danger-outline" onClick={() => setDeleting(area)}><Trash2 size={15} aria-hidden="true" /> Remove</button>
              </div>
            </div>)}
          </div>
        ) : <Empty label="No areas yet" text="Add an area before creating subscribers." />}
      </article>
      {formOpen && <Modal title={editing ? "Edit Area" : "Add Area"} onClose={() => { setFormOpen(false); setEditing(undefined); }}>
        <form className="modal-form single-column" onSubmit={submit}>
          <div className="modal-form-body">
            <p className="form-help">Use a short name your team will recognize, such as a village, street, or locality.</p>
            <label className="full-field">Area name<input name="displayName" autoFocus autoComplete="off" required maxLength={100} defaultValue={editing?.displayName} placeholder="e.g. Chamunda" /></label>
          </div>
          <div className="modal-actions full-field"><button type="button" className="secondary" onClick={() => { setFormOpen(false); setEditing(undefined); }}>Cancel</button><button className="primary" disabled={submitting}>{submitting ? "Saving…" : editing ? "Save Changes" : "Add Area"}</button></div>
        </form>
      </Modal>}
      {deleting && <Modal title="Remove Area" onClose={() => setDeleting(undefined)}>
        <div className="confirm-content">
          <span className="confirm-icon"><Trash2 size={20} aria-hidden="true" /></span>
          <div><h3>Remove {deleting.displayName}?</h3><p>You can remove an area only after its current and archived subscribers are assigned to another area.</p></div>
          <div className="modal-actions"><button className="secondary" onClick={() => setDeleting(undefined)}>Cancel</button><button className="primary danger-button" disabled={submitting} onClick={() => void remove(deleting)}>{submitting ? "Removing…" : "Remove Area"}</button></div>
        </div>
      </Modal>}
    </section>
  );
}

export function CustomersPage({ serviceType, initialQuery = "", initialAction = "" }: { serviceType: ServiceType; initialQuery?: string; initialAction?: string }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [archivedCustomers, setArchivedCustomers] = useState<Customer[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDebouncedValue(query, 240);
  const [statusFilter, setStatusFilter] = useState<"all" | Customer["status"]>(
    "all",
  );
  const [areaFilter, setAreaFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [dueOnly, setDueOnly] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [customerOffset, setCustomerOffset] = useState(0);
  const [customerTotal, setCustomerTotal] = useState(0);
  const customerPageSize = 100;
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
  const financialPopoverDialog = useRef<HTMLElement>(null);
  const [summaryHistory, setSummaryHistory] = useState<{
    invoices: Invoice[];
    payments: Payment[];
  }>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [quickInvoice, setQuickInvoice] = useState<Customer>();
  const [quickPayment, setQuickPayment] = useState<Customer>();
  const [quickPaymentMode, setQuickPaymentMode] = useState<"cash" | "upi">("cash");
  const [actionsCustomer, setActionsCustomer] = useState<Customer>();
  const [statusCustomer, setStatusCustomer] = useState<Customer>();
  const [paymentRequestKey, setPaymentRequestKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [deleting, setDeleting] = useState<Customer>();
  const [archiveReason, setArchiveReason] = useState("");
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const [bulkArchiveReason, setBulkArchiveReason] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [restoreReason, setRestoreReason] = useState("");
  const [permanentlyDeleting, setPermanentlyDeleting] = useState<Customer>();
  const [permanentDeleteReason, setPermanentDeleteReason] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(
    () => new Set(),
  );
  const refreshSequence = useRef(0);
  const routeActionHandled = useRef(false);
  const refresh = useCallback(
    (search: string, offset = 0) => {
      const sequence = ++refreshSequence.current;
      setLoading(true);
      Promise.all([
        listAreas(serviceType),
        listPlans(serviceType),
        listCustomers(serviceType, search, false, { status: statusFilter, areaId: areaFilter, planId: planFilter, dueOnly, limit: customerPageSize, offset }),
      ])
        .then(([nextAreas, nextPlans, nextCustomers]) => {
          if (sequence !== refreshSequence.current) return;
          setAreas(nextAreas);
          setPlans(nextPlans);
          setCustomers(nextCustomers.items);
          setCustomerTotal(nextCustomers.total);
          const availableIds = new Set(nextCustomers.items.map(({ id }) => id));
          setSelectedCustomerIds(
            (selected) =>
              new Set([...selected].filter((id) => availableIds.has(id))),
          );
        })
        .catch((error: Error) => {
          if (sequence === refreshSequence.current) {
            setNotice({ kind: "error", message: error.message });
          }
        })
        .finally(() => {
          if (sequence === refreshSequence.current) setLoading(false);
        });
    },
    [areaFilter, customerPageSize, dueOnly, planFilter, serviceType, statusFilter],
  );
  const loadArchived = useCallback(() => {
    setArchivedLoading(true);
    listCustomers(serviceType, "", true, { limit: 500 })
      .then((result) => setArchivedCustomers(result.items))
      .catch((error: Error) => setNotice({ kind: "error", message: error.message }))
      .finally(() => setArchivedLoading(false));
  }, [serviceType]);
  const previousService = useRef<ServiceType | undefined>(undefined);
  useEffect(() => {
    if (!financialPopover) return;
    const previous = document.activeElement as HTMLElement | null;
    financialPopoverDialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [financialPopover]);
  useEffect(() => {
    const serviceChanged = previousService.current !== serviceType;
    previousService.current = serviceType;
    if (serviceChanged) {
      setQuery(initialQuery);
      setEditing(undefined);
      setFormOpen(false);
      setArchivedCustomers([]);
      setSelectedCustomerIds(new Set());
    }
    setCustomerOffset(0);
    refresh(serviceChanged ? initialQuery : deferredQuery, 0);
  }, [deferredQuery, initialQuery, refresh, serviceType]);

  const filteredCustomers = useMemo(() => customers, [customers]);
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
        message: editing ? "Customer updated." : "Customer saved.",
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
  async function changeCustomerStatus(customer: Customer) {
    if (hasProtectedServicePeriod(customer)) return;
    const status = customer.status === "active" ? "inactive" : "active";
    const action = status === "active" ? "activate" : "deactivate";
    setSubmitting(true);
    try {
      await updateCustomer(serviceType, {
        id: customer.id,
        name: customer.name,
        areaId: customer.areaId,
        phone: customer.phone ?? undefined,
        stbNumber: customer.stbNumber ?? undefined,
        planId: customer.planId ?? undefined,
        installationDate: customer.installationDate ?? undefined,
        status,
        restartDate: status === "active" ? todayInBusinessTimezone() : undefined,
        statusReason: `Manually ${action}d after the service period ended`,
      });
      setActionsCustomer(undefined);
      setStatusCustomer(undefined);
      setNotice({
        kind: "success",
        message: `${customer.name} is now ${status === "active" ? "active" : "inactive"}.`,
      });
      refresh(query);
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : `Unable to ${action} customer.`,
      });
    } finally {
      setSubmitting(false);
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
        message: "Customer archived. Financial history was retained.",
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
    setQuickPaymentMode("cash");
    setQuickPayment(customer);
  };
  async function restoreArchived(customer: Customer) {
    setSubmitting(true);
    try {
      await restoreCustomer(serviceType, customer.id, restoreReason);
      setArchivedCustomers((current) => current.filter(({ id }) => id !== customer.id));
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
      setArchivedCustomers((current) => current.filter(({ id }) => id !== permanentlyDeleting.id));
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
        "Account Status": customer.status === "active" ? "Enabled" : "Suspended",
      })),
    );
  }
  const openSummary = useCallback((customer: Customer) => {
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
  }, [serviceType]);
  useEffect(() => {
    if (routeActionHandled.current || initialAction !== "add") return;
    routeActionHandled.current = true;
    setNotice(undefined);
    setEditing(undefined);
    setFormOpen(true);
  }, [initialAction]);
  useEffect(() => {
    if (routeActionHandled.current || loading || !initialQuery || !customers.length) return;
    const customer = customers.find((item) => item.customerCode === initialQuery) ?? customers[0];
    if (!customer) return;
    routeActionHandled.current = true;
    if (initialAction === "recharge") setQuickInvoice(customer);
    else if (initialAction === "payment") openPayment(customer);
    else if (initialAction === "setup") openEdit(customer);
    else if (initialAction === "view") openSummary(customer);
  }, [customers, initialAction, initialQuery, loading, openSummary]);
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
  async function archiveSelectedCustomers() {
    const ids = [...selectedCustomerIds];
    if (!ids.length) return;
    setSubmitting(true);
    try {
      const result = await archiveCustomers(serviceType, ids, bulkArchiveReason);
      setBulkArchiveOpen(false);
      setBulkArchiveReason("");
      setSelectedCustomerIds(new Set());
      setNotice({
        kind: "success",
        message: `${result.archived} subscriber${result.archived === 1 ? "" : "s"} archived. Financial history was retained.`,
      });
      refresh(query, customerOffset);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to archive the selected subscribers.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page-content">
      <PageTitle
        title="Subscribers"
        subtitle="Find a subscriber and complete the next action quickly."
        action={
          <div className="page-actions subscriber-page-actions">
            <button className="secondary" onClick={exportSubscribers}>
              <Download size={16} />
              {selectedCustomerIds.size
                ? `Export Selected (${selectedCustomerIds.size})`
                : "Export"}
            </button>
            <button className="secondary" onClick={() => { setArchivedOpen(true); loadArchived(); }}>
              <Archive size={16} /> Archived{archivedCustomers.length ? ` (${archivedCustomers.length})` : ""}
            </button>
            <button className="primary" onClick={openAdd}>
              <Plus size={16} /> Add Subscriber
            </button>
          </div>
        }
      />
      {notice && <NoticeMessage notice={notice} />}
      <article className={`panel customer-filters${mobileFiltersOpen ? " mobile-filters-open" : ""}`}>
        <div className="search-row">
          <Search size={17} aria-hidden="true" />
          <input
            name="subscriberSearch"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { setCustomerOffset(0); refresh(query, 0); }
            }}
            placeholder="Search name, ID, phone or STB…"
            aria-label="Search customers"
          />
          <button className="secondary" onClick={() => { setCustomerOffset(0); refresh(query, 0); }}>
            Search
          </button>
          <button className="secondary mobile-filter-toggle" aria-label={mobileFiltersOpen ? "Hide subscriber filters" : "Show subscriber filters"} aria-expanded={mobileFiltersOpen} onClick={() => setMobileFiltersOpen((open) => !open)}>
            <SlidersHorizontal size={18} aria-hidden="true" />
          </button>
        </div>
        <nav className="mobile-subscriber-tabs" aria-label="Subscriber filters">
          <button className={!dueOnly && statusFilter === "all" ? "active" : ""} aria-pressed={!dueOnly && statusFilter === "all"} onClick={() => { setDueOnly(false); setStatusFilter("all"); }}>All</button>
          <button className={dueOnly ? "active" : ""} aria-pressed={dueOnly} onClick={() => { setDueOnly(true); setStatusFilter("all"); }}>Due</button>
          <button className={!dueOnly && statusFilter === "inactive" ? "active" : ""} aria-pressed={!dueOnly && statusFilter === "inactive"} onClick={() => { setDueOnly(false); setStatusFilter("inactive"); }}>Inactive</button>
        </nav>
        <div className="customer-filter-grid">
          <label className="due-toggle">
            <input
              name="subscriberDueOnly"
              type="checkbox"
              checked={dueOnly}
              onChange={(event) => setDueOnly(event.target.checked)}
            />
            <span>Unpaid Balance Only</span>
          </label>
          <label>
            <span className="sr-only">Status</span>
            <select
              name="subscriberStatus"
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as typeof statusFilter)
              }
            >
              <option value="all">All Accounts</option>
              <option value="active">Open Accounts</option>
              <option value="inactive">Suspended Accounts</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Area</span>
            <select
              name="subscriberArea"
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
              name="subscriberPlan"
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
      <article className="panel table-panel responsive-register register-panel customer-register">
        <div className="register-heading">
          <h2>Subscribers</h2>
          <span>
            {selectedCustomerIds.size
              ? `${selectedCustomerIds.size} selected`
              : `${customerTotal} shown`}
          </span>
        </div>
        {loading ? (
          <p className="empty-inline loading-inline" role="status">Loading customers…</p>
        ) : filteredCustomers.length ? (
          <>
          <div className="mobile-subscriber-list" role="list">
            {filteredCustomers.map((customer) => {
              const canInvoice = canRecharge(customer);
              const paymentDue = netDue(customer) > 0;
              return (
                <article className="mobile-subscriber-row" role="listitem" key={`mobile-${customer.id}`}>
                  <button className="mobile-subscriber-main" onClick={() => openSummary(customer)} aria-label={`Open ${customer.name}`}>
                    <i className="avatar" aria-hidden="true">{customer.name.slice(0, 1).toUpperCase()}</i>
                    <span className="mobile-subscriber-copy">
                      <strong>{customer.name}</strong>
                      <small>{customer.customerCode}{customer.phone ? ` · ${customer.phone}` : customer.stbNumber ? ` · STB ${customer.stbNumber}` : ""}</small>
                      <small>{customer.areaName} · {customer.planName || "Plan missing"}</small>
                    </span>
                    <span className="mobile-subscriber-balance">
                      <strong className={paymentDue ? "amount-due" : netDue(customer) < 0 ? "amount-credit" : ""}>{accountPosition(customer)}</strong>
                      <small className={`mobile-status-pill ${paymentDue ? "due" : customer.status}`}>{paymentDue ? "Due" : customer.status === "active" ? "Active" : "Inactive"}</small>
                    </span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                  <div className="mobile-subscriber-actions">
                    <span>{coverageLabel(customer)}</span>
                    <button className={paymentDue || canInvoice ? "primary" : "secondary"} onClick={() => paymentDue ? openPayment(customer) : canInvoice ? setQuickInvoice(customer) : openEdit(customer)}>
                      {paymentDue ? <Wallet size={15} aria-hidden="true" /> : canInvoice ? <FileText size={15} aria-hidden="true" /> : <Pencil size={15} aria-hidden="true" />}
                      {paymentDue ? "Pay" : canInvoice ? "Recharge" : "Setup"}
                    </button>
                    <button className="secondary mobile-more-action" onClick={() => setActionsCustomer(customer)} aria-label={`More actions for ${customer.name}`}><MoreHorizontal size={16} aria-hidden="true" /><span>More</span></button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="table-wrap desktop-subscriber-table">
            <table>
              <thead>
                <tr>
                  <th className="subscriber-select-column">
                    <input
                      className="subscriber-checkbox"
                      type="checkbox"
                      checked={allShownSelected}
                      onChange={toggleAllShownCustomers}
                      aria-label="Select all shown customers"
                    />
                  </th>
                  <th className="subscriber-number-column">No.</th>
                  <th>Customer</th>
                  <th>Plan</th>
                  <th>Service</th>
                  <th>Balance</th>
                  <th className="row-actions-column">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((customer) => {
                  const canInvoice = canRecharge(customer);
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
                      <td data-label="Customer">
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
                            <small>{customer.stbNumber ? `STB ${customer.stbNumber} · ` : ""}{customer.areaName}</small>
                          </span>
                        </span>
                      </td>
                      <td data-label="Plan">
                        <strong>{customer.planName || "Plan missing"}</strong>
                        <small>{customer.areaName}</small>
                      </td>
                      <td data-label="Service">
                        <small
                          className={`coverage-label ${customer.serviceStatus}`}
                        >
                          {coverageLabel(customer)}
                        </small>
                        <small className={`account-label ${customer.status}`}>{customer.status === "active" ? "Account open" : "Account suspended"}</small>
                        {customer.hasHistoricalGap ? (
                          <small className="billing-gap-warning">
                            <strong>Service dates not billed</strong>
                            {customer.historicalGapStart && customer.historicalGapEnd
                              ? `${formatBusinessDate(customer.historicalGapStart)} – ${formatBusinessDate(customer.historicalGapEnd)} (${customer.historicalGapDays} days)`
                              : "Review this customer’s bill dates"}
                          </small>
                        ) : null}
                      </td>
                      <td data-label="Balance">
                        <button
                          className={`balance-link ${netDue(customer) > 0 ? "amount-due" : netDue(customer) < 0 ? "amount-credit" : ""}`}
                          aria-label={`View balance details for ${customer.name}`}
                          aria-expanded={financialPopover?.customer.id === customer.id}
                          onClick={(event) => {
                            const bounds = event.currentTarget.getBoundingClientRect();
                            setFinancialPopover((current) => current?.customer.id === customer.id ? undefined : { customer, left: Math.min(Math.max(12, bounds.left - 8), window.innerWidth - 348), top: Math.min(bounds.bottom + 8, window.innerHeight - 250) });
                          }}
                        >
                          <strong>{accountPosition(customer)}</strong>
                          <small>{netDue(customer) > 0 ? formatDueStatus(customer) : netDue(customer) < 0 ? "Customer credit" : "No payment due"}</small>
                        </button>
                      </td>
                      <td className="row-actions-column" data-label="Actions">
                        <div className="action-row customer-actions quick-row-actions">
                          <button className="secondary row-action-button" title={`View history for ${customer.name}`} onClick={() => openSummary(customer)}><Clock size={15} aria-hidden="true" /><span>View</span></button>
                          <button className="primary row-action-button" title={canInvoice ? `Add recharge for ${customer.name}` : `Complete setup for ${customer.name}`} onClick={() => canInvoice ? setQuickInvoice(customer) : openEdit(customer)}>{canInvoice ? <FileText size={15} aria-hidden="true" /> : <Pencil size={15} aria-hidden="true" />}<span>{canInvoice ? "Recharge" : "Setup"}</span></button>
                          <button className="secondary row-action-button" title={`Record payment for ${customer.name}`} onClick={() => openPayment(customer)}><Wallet size={15} aria-hidden="true" /><span>Pay</span></button>
                          <button className="secondary row-action-button" title={`Actions for ${customer.name}`} onClick={() => setActionsCustomer(customer)}><MoreHorizontal size={16} aria-hidden="true" /><span>Actions</span></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
      ) : (
          <Empty
            label="No customers found"
            text="Change the filters or add a customer."
          />
        )}
        {!loading && customerTotal > customerPageSize ? (
          <nav className="pagination" aria-label="Subscriber pages">
            <span>
              Showing {customerOffset + 1}–{Math.min(customerOffset + customerPageSize, customerTotal)} of {customerTotal}
            </span>
            <div className="pagination-actions">
              <button className="secondary" disabled={customerOffset === 0} onClick={() => { const next = Math.max(0, customerOffset - customerPageSize); setCustomerOffset(next); refresh(query, next); }}>Previous</button>
              <button className="secondary" disabled={customerOffset + customerPageSize >= customerTotal} onClick={() => { const next = customerOffset + customerPageSize; setCustomerOffset(next); refresh(query, next); }}>Next</button>
            </div>
          </nav>
        ) : null}
      </article>

      {selectedCustomerIds.size > 0 ? (
        <aside className="subscriber-bulk-bar" aria-label="Selected subscriber actions">
          <span className="subscriber-bulk-count" aria-hidden="true">
            <Archive size={18} />
          </span>
          <span className="subscriber-bulk-summary">
            <strong>{selectedCustomerIds.size} selected</strong>
            <small>Actions apply to this page selection</small>
          </span>
          <span className="subscriber-bulk-actions">
            <button className="bulk-bar-button" onClick={exportSubscribers}>
              <Download size={15} /> Export
            </button>
            <button
              className="bulk-bar-button bulk-bar-danger"
              onClick={() => {
                setBulkArchiveReason("");
                setBulkArchiveOpen(true);
              }}
            >
              <Archive size={15} /> Archive
            </button>
            <button
              className="bulk-bar-clear"
              onClick={() => setSelectedCustomerIds(new Set())}
            >
              Clear
            </button>
          </span>
        </aside>
      ) : null}

      {financialPopover ? createPortal(
        <div
          className="financial-popover-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setFinancialPopover(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFinancialPopover(undefined);
            if (event.key === "Tab") {
              event.preventDefault();
              financialPopoverDialog.current?.querySelector<HTMLElement>("button")?.focus();
            }
          }}
        >
          <section
            ref={financialPopoverDialog}
            className="financial-popover"
            role="dialog"
            aria-modal="true"
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
        </div>,
        document.body,
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
          <details className="area-manager">
            <summary>Manage service areas</summary>
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
          </details>
          <form
            className="modal-form customer-form"
            key={editing?.id ?? "new"}
            onSubmit={saveCustomer}
          >
            <div className="modal-form-body">
            <label>
              Name *
              <input
                name="name"
                autoComplete="name"
                required
                maxLength={160}
                defaultValue={editing?.name}
                placeholder="Enter full name"
              />
            </label>
            <label>
              Phone
              <input
                name="phone"
                type="tel"
                autoComplete="tel"
                maxLength={30}
                defaultValue={editing?.phone ?? ""}
                placeholder="Enter mobile number"
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
                placeholder="Enter STB number"
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
              Plan
              <select name="planId" defaultValue={editing?.planId ?? ""}>
                <option value="">Select plan (optional)</option>
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
              Service Start Date
              <input
                name="installationDate"
                type="date"
                defaultValue={editing?.installationDate ?? todayInBusinessTimezone()}
              />
              <span className="form-help">
                The first day this customer received service. Existing bills protect
                this date from moving after billed service.
              </span>
            </label>
            {editing ? (
              <>
                <label>
                  Account Control
                  <select name="status" defaultValue={editing.status}>
                    <option value="active">Account Open</option>
                    <option
                      value="inactive"
                      disabled={editing.status === "active" && hasProtectedServicePeriod(editing)}
                    >
                      Account Suspended
                    </option>
                  </select>
                  {editing.status === "active" && hasProtectedServicePeriod(editing) ? (
                    <span className="form-help">
                      This account cannot be deactivated before its billed service ends
                      {editing.latestPeriodEnd ? ` on ${formatBusinessDate(editing.latestPeriodEnd)}` : ""}.
                    </span>
                  ) : null}
                </label>
                {editing.status === "inactive" ? (
                  <label>
                    Service Restarts
                    <input
                      name="restartDate"
                      type="date"
                      defaultValue={todayInBusinessTimezone()}
                    />
                  </label>
                ) : null}
                <label className="full-field">
                  Account Change Reason
                  <input
                    name="statusReason"
                    maxLength={250}
                    placeholder="Example: Customer requested service pause…"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="opening-balance-field">
                  Opening Balance
                  <input
                    name="openingBalance"
                    autoComplete="off"
                    inputMode="decimal"
                    defaultValue="0"
                    pattern="\d+(\.\d{1,2})?"
                  />
                </label>
                <label className="opening-balance-field">
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
            </div>
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
                    : "Save Subscriber"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {summary && (
        <Modal
          title="Customer Balance & History"
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
                <dt>Next recharge starts</dt>
                <dd>
                  {summary.nextBillingStartDate
                    ? formatBusinessDate(summary.nextBillingStartDate)
                    : "Not configured"}
                </dd>
              </div>
              <div>
                <dt>Recharge period due</dt>
                <dd>{formatDuePeriod(summary)}</dd>
              </div>
              <div>
                <dt>Open bills</dt>
                <dd>{summary.openInvoiceCount}</dd>
              </div>
              <div>
                <dt>Older unpaid amount</dt>
                <dd className={summary.previousDuePaise > 0 ? "amount-due" : ""}>
                  {formatRupees(summary.previousDuePaise)}
                </dd>
              </div>
              <div>
                <dt>Current recharge due</dt>
                <dd className={summary.currentPlanDuePaise > 0 ? "amount-due" : ""}>
                  {formatRupees(summary.currentPlanDuePaise)}
                </dd>
              </div>
              <div>
                <dt>Future recharge due</dt>
                <dd className={summary.futurePlanDuePaise > 0 ? "amount-due" : ""}>
                  {formatRupees(summary.futurePlanDuePaise)}
                </dd>
              </div>
              <div>
                <dt>Customer credit</dt>
                <dd
                  className={
                    summary.creditBalancePaise > 0 ? "amount-credit" : ""
                  }
                >
                  {formatRupees(summary.creditBalancePaise)}
                </dd>
              </div>
              <div className="summary-net">
                <dt>Balance</dt>
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
                  <small>Bills and payments, including the current recharge</small>
                </span>
                <strong>{accountHistory.length} entries</strong>
              </div>
              {summaryLoading ? (
                <p className="empty-inline loading-inline" role="status">Loading history…</p>
              ) : accountHistory.length ? (
                <div className="history-ledger" role="list" aria-label="Account transactions, newest first">
                  {accountHistory.map((entry) =>
                    entry.kind === "invoice" ? (
                      <article className="ledger-entry invoice" role="listitem" key={`invoice-${entry.id}`}>
                        <div className="ledger-primary">
                          <strong className="amount-due">−{formatRupees(entry.invoice.chargeAmountPaise)}</strong>
                          <small>Bill · {entry.invoice.status}</small>
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
                <p className="empty-inline" role="status">No invoices or payments recorded.</p>
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
                Edit Customer
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
      {actionsCustomer ? (
        <Modal
          title={`${actionsCustomer.name} Actions`}
          compact
          onClose={() => setActionsCustomer(undefined)}
        >
          <div className="customer-action-menu">
            <p>Choose an action for {actionsCustomer.customerCode}.</p>
            <button
              className="secondary mobile-customer-action"
              onClick={() => {
                const customer = actionsCustomer;
                setActionsCustomer(undefined);
                openSummary(customer);
              }}
            >
              <Clock size={16} aria-hidden="true" /> View History
            </button>
            <button
              className="primary mobile-customer-action"
              onClick={() => {
                const customer = actionsCustomer;
                setActionsCustomer(undefined);
                if (canRecharge(customer)) setQuickInvoice(customer);
                else openEdit(customer);
              }}
            >
              {canRecharge(actionsCustomer) ? (
                <FileText size={16} aria-hidden="true" />
              ) : (
                <Pencil size={16} aria-hidden="true" />
              )}{" "}
              {canRecharge(actionsCustomer) ? "Add Recharge" : "Complete Setup"}
            </button>
            <button
              className="secondary mobile-customer-action"
              onClick={() => {
                const customer = actionsCustomer;
                setActionsCustomer(undefined);
                openPayment(customer);
              }}
            >
              <Wallet size={16} aria-hidden="true" /> Record Payment
            </button>
            <button
              className="secondary"
              onClick={() => {
                const customer = actionsCustomer;
                setActionsCustomer(undefined);
                openEdit(customer);
              }}
            >
              <Pencil size={16} aria-hidden="true" /> Edit Customer & Account
            </button>
            <button
              className={
                hasProtectedServicePeriod(actionsCustomer)
                  ? "secondary"
                  : actionsCustomer.status === "active"
                    ? "danger-button"
                    : "secondary"
              }
              disabled={submitting || hasProtectedServicePeriod(actionsCustomer)}
              onClick={() => {
                setStatusCustomer(actionsCustomer);
                setActionsCustomer(undefined);
              }}
            >
              {hasProtectedServicePeriod(actionsCustomer) ? (
                <Clock size={16} aria-hidden="true" />
              ) : actionsCustomer.status === "active" ? (
                <Archive size={16} aria-hidden="true" />
              ) : (
                <RotateCcw size={16} aria-hidden="true" />
              )}{" "}
              {hasProtectedServicePeriod(actionsCustomer)
                ? `Active until ${actionsCustomer.latestPeriodEnd ? formatBusinessDate(actionsCustomer.latestPeriodEnd) : "service ends"}`
                : actionsCustomer.status === "active"
                  ? "Deactivate Account"
                  : "Activate Account"}
            </button>
            {hasProtectedServicePeriod(actionsCustomer) ? (
              <small className="status-change-help">
                Deactivate becomes available the day after the billed service period ends.
              </small>
            ) : null}
            <button
              className="danger-button"
              onClick={() => {
                const customer = actionsCustomer;
                setActionsCustomer(undefined);
                setArchiveReason("");
                setDeleting(customer);
              }}
            >
              <Trash2 size={16} aria-hidden="true" /> Archive Customer
            </button>
          </div>
        </Modal>
      ) : null}
      {statusCustomer ? (
        <Modal
          title={statusCustomer.status === "active" ? "Deactivate Account" : "Activate Account"}
          compact
          onClose={() => setStatusCustomer(undefined)}
        >
          <div className="confirm-content">
            <h3>{statusCustomer.name}</h3>
            <p>
              {statusCustomer.status === "active"
                ? "The billed service period has ended. Deactivating stops future recharges until an administrator activates this account again."
                : "Activate this account so the administrator can restart service and add the next recharge."}
            </p>
            <div className="modal-actions">
              <button
                className="secondary"
                disabled={submitting}
                onClick={() => setStatusCustomer(undefined)}
              >
                Cancel
              </button>
              <button
                className={statusCustomer.status === "active" ? "danger-button" : "primary"}
                disabled={submitting}
                onClick={() => void changeCustomerStatus(statusCustomer)}
              >
                {submitting
                  ? "Saving…"
                  : statusCustomer.status === "active"
                    ? "Deactivate Account"
                    : "Activate Account"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {quickInvoice && (
        <Modal
          title="Add Service Recharge"
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
                message: result.replayed
                  ? `${result.invoiceCode} already existed for ${quickInvoice.name}; no duplicate was created.${result.paymentCode ? ` Payment ${result.paymentCode} recorded.` : ""}`
                  : `${quickInvoice.name} recharged through ${formatBusinessDate(result.periodEnd)}. Bill ${result.invoiceCode} created.${result.paymentCode ? ` Payment ${result.paymentCode} recorded.` : ""}`,
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
            <div className="modal-form-body">
            <div className="quick-action-context full-field">
              <Wallet size={18} />
              <span>
                <strong>{quickPayment.name}</strong>
                <small>
                  Customer owes {formatRupees(quickPayment.amountDuePaise)} ·
                  Credit {formatRupees(quickPayment.creditBalancePaise)} · Pay now{" "}
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
                Create the first bill before recording this payment if you need to apply a discount. Otherwise, {formatRupees(quickPayment.unbilledOpeningDuePaise)} will be safely held as customer credit.
              </p>
            ) : null}
            <label>
              Payment Method
              <select name="paymentMode" value={quickPaymentMode} onChange={(event) => setQuickPaymentMode(event.target.value === "upi" ? "upi" : "cash")}>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
              </select>
            </label>
            <PaymentAmountFields
              key={quickPayment.id}
              duePaise={Math.max(
                0,
                quickPayment.amountDuePaise - quickPayment.creditBalancePaise,
              )}
              holdAsCredit={quickPayment.unbilledOpeningDuePaise > 0}
            />
            {quickPaymentMode === "upi" ? <label className="full-field">
              UPI Reference / UTR (optional)
              <input
                name="paymentReference"
                autoComplete="off"
                maxLength={120}
                placeholder="Enter it if available"
              />
            </label> : null}
            <details className="advanced-options full-field" open><summary>Payment Date & Notes</summary><label>Payment Date<input name="paymentDate" type="date" max={todayInBusinessTimezone()} defaultValue={todayInBusinessTimezone()} required /></label><label>Notes<input name="notes" autoComplete="off" maxLength={500} placeholder="Optional collection note…" /></label></details>
            </div>
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
      {bulkArchiveOpen && selectedCustomerIds.size > 0 ? (
        <Modal
          title="Archive Selected Subscribers"
          onClose={() => setBulkArchiveOpen(false)}
        >
          <div className="confirm-content bulk-archive-confirm">
            <span className="confirm-icon">
              <Archive size={20} aria-hidden="true" />
            </span>
            <div>
              <h3>Archive {selectedCustomerIds.size} subscriber{selectedCustomerIds.size === 1 ? "" : "s"}?</h3>
              <p>
                Future billing stops for these subscribers. Their invoices,
                receipts, balances, and audit history remain available and
                every subscriber can be restored later.
              </p>
              <label>
                Archive Note (optional)
                <textarea
                  value={bulkArchiveReason}
                  onChange={(event) => setBulkArchiveReason(event.target.value)}
                  maxLength={250}
                  placeholder="Example: Old test subscriber records"
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setBulkArchiveOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary danger-button"
                disabled={submitting}
                onClick={() => void archiveSelectedCustomers()}
              >
                {submitting ? "Archiving…" : `Archive ${selectedCustomerIds.size}`}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
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
            {archivedLoading ? <p className="empty-inline loading-inline" role="status">Loading archived subscribers…</p> : archivedCustomers.length ? (
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
                      onClick={() => {
                        setPermanentDeleteReason("");
                        setArchivedOpen(false);
                        setPermanentlyDeleting(customer);
                      }}
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
            <div className="modal-actions"><button className="secondary" onClick={() => setPermanentlyDeleting(undefined)}>Cancel</button><button className="danger-button" disabled={submitting} onClick={() => void permanentlyDeleteArchived()}><Trash2 size={15} aria-hidden="true" /> {submitting ? "Deleting…" : "Permanently Delete"}</button></div>
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
    <div className="empty-list" role="status">
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
