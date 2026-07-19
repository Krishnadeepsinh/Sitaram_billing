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
  listAreas,
  listCustomers,
  listInvoices,
  listPayments,
  listPlans,
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

type Notice = { kind: "success" | "error"; message: string } | undefined;

function formatDuePeriod(customer: Customer) {
  if (!customer.oldestDuePeriodStart || !customer.latestDuePeriodEnd)
    return "No pending invoice";
  const first = formatBusinessMonth(customer.oldestDuePeriodStart);
  const last = formatBusinessMonth(customer.latestDuePeriodEnd);
  return first === last ? first : `${first} – ${last}`;
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
        subtitle="Manage your subscription packages and pricing."
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
              Monthly Price (₹)
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
              Validity (Days)
              <input value="30" disabled aria-label="Validity in days" />
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
  const [updatingStatus, setUpdatingStatus] = useState<number>();
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
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
          (!dueOnly || customer.amountDuePaise > 0),
      ),
    [areaFilter, customers, dueOnly, planFilter, statusFilter],
  );

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
        name: String(data.get("name")),
        areaId: Number(data.get("areaId")),
        phone: String(data.get("phone")) || undefined,
        stbNumber: String(data.get("stbNumber")) || undefined,
        planId: Number(data.get("planId")) || undefined,
        installationDate: String(data.get("installationDate")) || undefined,
      };
      if (editing)
        await updateCustomer(serviceType, {
          id: editing.id,
          ...common,
          status: data.get("status") === "inactive" ? "inactive" : "active",
          restartDate: String(data.get("restartDate")) || undefined,
          statusReason: String(data.get("statusReason") || "") || undefined,
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
    setEditing(undefined);
    setFormOpen(true);
  };
  const openEdit = (customer: Customer) => {
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
  function exportSubscribers() {
    downloadCsv(
      `${serviceType}-subscribers.csv`,
      filteredCustomers.map((customer) => ({
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
      listInvoices(serviceType, customer.customerCode),
      listPayments(serviceType, { query: customer.customerCode }),
    ])
      .then(([invoices, payments]) =>
        setSummaryHistory({
          invoices: invoices.items,
          payments: payments.items,
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

  return (
    <section className="page-content">
      <PageTitle
        title="Subscribers"
        subtitle="Manage subscriber status, 30-day coverage, billing, and collections."
        action={
          <div className="page-actions">
            <button className="secondary" onClick={exportSubscribers}>
              <Download size={16} /> Export
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
          <span>{filteredCustomers.length} shown</span>
        </div>
        {loading ? (
          <p className="empty-inline">Loading subscribers…</p>
        ) : filteredCustomers.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Subscriber</th>
                  <th>STB / Area</th>
                  <th>Plan & Balance</th>
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
                    <tr key={customer.id}>
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
                        <div className="balance-cell">
                          <span>
                            <strong>{customer.planName || "No plan"}</strong>
                            <small
                              className={
                                customer.amountDuePaise > 0
                                  ? "amount-due"
                                  : customer.creditBalancePaise > 0
                                    ? "amount-credit"
                                    : ""
                              }
                            >
                              {customer.amountDuePaise > 0
                                ? `${formatRupees(customer.amountDuePaise)} due`
                                : customer.creditBalancePaise > 0
                                  ? `${formatRupees(customer.creditBalancePaise)} advance`
                                  : "Account settled"}
                            </small>
                            <small
                              className={`coverage-label ${customer.coverageStatus}`}
                            >
                              {coverageLabel(customer)}
                            </small>
                            <small>
                              Next bill:{" "}
                              {customer.nextBillingStartDate
                                ? formatBusinessDate(
                                    customer.nextBillingStartDate,
                                  )
                                : "Not configured"}
                            </small>
                            {customer.hasHistoricalGap ? (
                              <small className="amount-due">
                                Historical billing gap detected
                              </small>
                            ) : null}
                          </span>
                          <button
                            className="icon-button info-button"
                            aria-label={`View financial summary and history for ${customer.name}`}
                            title="Financial summary and history"
                            onClick={() => openSummary(customer)}
                          >
                            <Info size={15} aria-hidden="true" />
                          </button>
                          {customer.amountDuePaise > 0 ? (
                            <span
                              className="due-period"
                              title="Outstanding invoice period"
                            >
                              {formatDuePeriod(customer)}
                            </span>
                          ) : null}
                        </div>
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

      {formOpen && (
        <Modal
          title={editing ? `Edit ${editing.customerCode}` : "Add Subscriber"}
          wide
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
                <dt>Active plan dues</dt>
                <dd className={summary.amountDuePaise > 0 ? "amount-due" : ""}>
                  {formatRupees(summary.amountDuePaise)}
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
              <h3>Account history</h3>
              {summaryLoading ? (
                <p className="empty-inline">Loading history…</p>
              ) : (
                <div className="history-grid">
                  <section>
                    <h4>Invoices</h4>
                    {summaryHistory?.invoices.length ? (
                      summaryHistory.invoices.map((invoice) => (
                        <div className="history-row" key={invoice.id}>
                          <span>
                            <strong>{invoice.invoiceCode}</strong>
                            <small>
                              {formatBusinessDate(invoice.periodStart)} –{" "}
                              {formatBusinessDate(invoice.periodEnd)}
                            </small>
                          </span>
                          <span>
                            <strong>
                              {formatRupees(invoice.totalPayablePaise)}
                            </strong>
                            <small>{invoice.status}</small>
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="empty-inline">No invoices recorded.</p>
                    )}
                  </section>
                  <section>
                    <h4>Payments</h4>
                    {summaryHistory?.payments.length ? (
                      summaryHistory.payments.map((payment) => (
                        <div className="history-row" key={payment.id}>
                          <span>
                            <strong>{payment.paymentCode}</strong>
                            <small>
                              {formatBusinessDate(payment.paymentDate)} ·{" "}
                              {payment.paymentMode.replace("_", " ")}
                            </small>
                          </span>
                          <span>
                            <strong>
                              {formatRupees(payment.amountReceivedPaise)}
                            </strong>
                            <small>
                              {payment.resultingStatus.replace("_", " ")}
                            </small>
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="empty-inline">No payments recorded.</p>
                    )}
                  </section>
                </div>
              )}
            </div>
            <div className="modal-actions">
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
                Archive Reason *
                <textarea
                  value={archiveReason}
                  onChange={(event) => setArchiveReason(event.target.value)}
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
                disabled={submitting || archiveReason.trim().length < 5}
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
            {archivedCustomers.length ? (
              archivedCustomers.map((customer) => (
                <div className="history-row" key={customer.id}>
                  <span>
                    <strong>{customer.name}</strong>
                    <small>
                      {customer.customerCode} · {accountPosition(customer)}
                    </small>
                  </span>
                  <button
                    className="secondary"
                    disabled={submitting || restoreReason.trim().length < 5}
                    onClick={() => void restoreArchived(customer)}
                  >
                    <RotateCcw size={15} /> Restore
                  </button>
                </div>
              ))
            ) : (
              <Empty
                label="No archived subscribers"
                text="Archived subscribers will appear here."
              />
            )}
            <label>
              Restore Reason *
              <textarea
                value={restoreReason}
                onChange={(event) => setRestoreReason(event.target.value)}
                minLength={5}
                maxLength={250}
                placeholder="Reason applies to the subscriber you restore"
              />
            </label>
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
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
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
        className={wide ? "modal modal-wide" : "modal"}
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
