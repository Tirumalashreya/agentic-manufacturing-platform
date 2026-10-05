import type { Metadata } from "next";
import { StageTracker } from "@/components/manufacturing/StageTracker";
import { WhatIfForm } from "@/components/manufacturing/WhatIfForm";
import { RescheduleActions } from "@/components/manufacturing/RescheduleActions";
import { PageHeader, Panel, StatusBadge, ErrorState, AlertBanner } from "@/components/ui";

const API_BASE_URL = process.env.AGENT_ORCHESTRATOR_URL ?? "http://localhost:8000";

export const metadata: Metadata = { title: "Sales Order" };

type SalesOrderDetail = {
  sales_order: {
    sales_order_id: string;
    customer_name: string | null;
    product_name: string | null;
    quantity: number | null;
    unit_price: number | null;
    total_amount: number | null;
    requested_deadline: string | null;
    status: string;
    created_at: string;
  };
  production_order_id: string | null;
  production_plan: {
    quantity: number;
    materials: { component_id: string; component_name: string; required: number; available: number; shortage: number }[];
    routing_operations: { operation_id: string; operation: string; op_number: number; work_center_code: string }[];
    verdict: string;
    verdict_basis: string;
  } | null;
  schedule: {
    stage: string;
    operations: { operation: string; machine: string | null; operator: string | null; status: string; scheduled_start: string | null; scheduled_end: string | null }[];
    delivery: { delivery_id: string; status: string; confirmed_delivery_date: string | null } | null;
    invoice: { invoice_id: string; status: string; invoice_amount: number } | null;
  } | null;
  capacity: {
    machines: { machineId: string; machineName: string; loadPct: number }[];
    bottlenecks: { machineId: string; machineName: string; loadPct: number }[];
    bottleneck_threshold_pct: number;
  } | null;
  work_centers: { id: string; code: string }[];
  missing: string[];
};

// Order Control Center (Phase 3, agreed with the user): the real,
// persisted per-line fulfillment record — GET /sales-orders/{id}/fulfillment,
// built and live-verified in the fulfillment-architecture-hardening phase.
// `available: false` is an honest state (dual-write predates this order, or
// failed best-effort at creation time), not an error — rendered as such,
// never hidden or guessed at.
type FulfillmentDetail =
  | { available: false }
  | {
      available: true;
      status: string;
      order_line: { product_name: string; quantity: number; unit_price: number } | null;
      fulfillment_plan: {
        strategy: string;
        reasoning: string | null;
        lines: {
          source_type: string;
          quantity: number;
          status: string;
          production_order_id: string | null;
          vendor_id: string | null;
          vendor_name: string | null;
          promised_date?: string | null;
          execution_reference?: string | null;
        }[];
      } | null;
    };

function fulfillmentLineTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "FULFILLED") return "success";
  if (status === "FAILED" || status === "CANCELLED") return "danger";
  if (status === "ON_HOLD") return "warning";
  return "neutral";
}

function verdictTone(verdict: string): "success" | "danger" | "warning" {
  if (verdict === "PASS") return "success";
  // This page's verdict comes from sales_orders.py's live materials-only
  // snapshot, which never calls the scheduler — only PASS/MATERIAL_SHORTAGE/
  // PLANNING_CONFIGURATION_ISSUE are reachable here (see that endpoint's
  // own doc comment); WAITING_FOR_PRODUCTION_SLOT/PLANNER_REVIEW are
  // scheduler-derived and only appear on the approval-time preview instead.
  if (verdict === "MATERIAL_SHORTAGE" || verdict === "PLANNING_CONFIGURATION_ISSUE") return "danger";
  return "warning";
}

// Real per-Sales-Order planning workspace inside Ledger — Order →
// Production → Planning → Scheduling → APS status, all in one place, so
// a Sales Order user never has to leave Ledger to understand where an
// order stands. What-if is real and non-committing. Reschedule/Optimize
// are now real and committing too (agreed with the user) — buildable
// once scheduling-service's SINGLE/AFFECTED scope genuinely narrowed to
// real orders instead of silently rescheduling the whole plant (see
// pipeline.ts's resolveScopedOrderIds). Reschedule = SINGLE (this order
// only); Optimize = AFFECTED (this order + any real order sharing its
// work centers), labeled honestly with the real affected count before
// it's even clicked. Operator execution (Start/Complete/My Jobs) stays
// exclusively on APS Platform; nothing here duplicates that.
export default async function SalesOrderDetailPage({
  params,
}: {
  params: Promise<{ salesOrderId: string }>;
}) {
  const { salesOrderId } = await params;
  const res = await fetch(`${API_BASE_URL}/sales-orders/${encodeURIComponent(salesOrderId)}/detail`, { cache: "no-store" });

  if (res.status === 404) {
    return (
      <div>
        <PageHeader kicker="SALES ORDER" title="Sales Order" />
        <ErrorState title="Not found" description={`No sales order found with id ${salesOrderId}.`} />
      </div>
    );
  }
  if (!res.ok) {
    return (
      <div>
        <PageHeader kicker="SALES ORDER" title="Sales Order" />
        <ErrorState title="Could not load this order" description={`agent-orchestrator returned ${res.status}.`} />
      </div>
    );
  }

  const detail = (await res.json()) as SalesOrderDetail;
  const { sales_order, production_plan, schedule, capacity, work_centers, missing } = detail;

  const fulfillmentRes = await fetch(
    `${API_BASE_URL}/sales-orders/${encodeURIComponent(salesOrderId)}/fulfillment`,
    { cache: "no-store" }
  );
  const fulfillment: FulfillmentDetail = fulfillmentRes.ok
    ? await fulfillmentRes.json()
    : { available: false };

  const doneOps = schedule?.operations.filter((o) => o.status === "DONE").length ?? 0;
  const totalOps = schedule?.operations.length ?? 0;
  const currentCompletion = schedule && schedule.operations.length > 0
    ? schedule.operations.reduce((latest, op) => (op.scheduled_end && op.scheduled_end > latest ? op.scheduled_end : latest), "")
    : null;

  return (
    <div>
      <PageHeader
        kicker="SALES ORDER"
        title={sales_order.sales_order_id}
        description={`${sales_order.customer_name} · ${sales_order.quantity} × ${sales_order.product_name} — the planning workspace for this order, entirely inside Ledger. Read-only for now: no committing actions yet.`}
      />

      {/* 1. Overview */}
      <Panel title="Overview">
        <table className="grid">
          <tbody>
            <tr><td className="mono">Customer</td><td>{sales_order.customer_name ?? "—"}</td></tr>
            <tr><td className="mono">Product</td><td>{sales_order.product_name ?? "—"}</td></tr>
            <tr><td className="mono">Quantity</td><td>{sales_order.quantity ?? "—"}</td></tr>
            <tr><td className="mono">Requested delivery</td><td>{sales_order.requested_deadline ?? "—"}</td></tr>
            <tr>
              <td className="mono">Order status</td>
              <td><StatusBadge tone={sales_order.status === "CREDIT_BLOCKED" ? "danger" : "success"}>{sales_order.status}</StatusBadge></td>
            </tr>
            <tr>
              <td className="mono">Production status</td>
              <td>
                {schedule ? (
                  <StageTracker status={schedule.stage} doneOps={doneOps} totalOps={totalOps} />
                ) : (
                  <span style={{ color: "var(--text-faint)" }}>No production order linked</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>

      {/* Fulfillment — Order Control Center (Phase 3, agreed with the
          user): the real per-line fulfillment record (strategy, source,
          quantity, independent lifecycle status, promised date, execution
          reference) — this used to be a static hint text with no real
          data behind it (see the Phase 1 audit that found this gap); now
          it's the real, live-verified FulfillmentPlan/FulfillmentLine
          record built this session. */}
      <Panel title="Fulfillment">
        {!fulfillment.available || !fulfillment.fulfillment_plan ? (
          <p style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
            No real fulfillment record for this order yet — it predates this feature, or fulfillment hasn&apos;t been approved.
          </p>
        ) : (
          <>
            <p className="panel-sub">
              Strategy: <StatusBadge tone="neutral">{fulfillment.fulfillment_plan.strategy}</StatusBadge>
              {fulfillment.fulfillment_plan.reasoning ? ` — ${fulfillment.fulfillment_plan.reasoning}` : ""}
            </p>
            <table className="grid">
              <thead>
                <tr><th>Source</th><th>Qty</th><th>Status</th><th>Promised</th><th>Execution</th></tr>
              </thead>
              <tbody>
                {fulfillment.fulfillment_plan.lines.map((line, i) => (
                  <tr key={i}>
                    <td>{line.source_type}</td>
                    <td>{line.quantity}</td>
                    <td><StatusBadge tone={fulfillmentLineTone(line.status)}>{line.status}</StatusBadge></td>
                    <td>{line.promised_date ? new Date(line.promised_date).toLocaleDateString() : "—"}</td>
                    <td>
                      {line.production_order_id
                        ? `Production Order ${line.production_order_id}`
                        : line.execution_reference
                          ? `${line.vendor_name ? `${line.vendor_name} — ` : ""}${line.execution_reference}`
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      {/* 2. Production Plan */}
      <Panel title="Production Plan">
        {!production_plan ? (
          <p style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
            No production order exists for this sales order — fulfilled from stock, sourced from a vendor, or not yet approved.
          </p>
        ) : (
          <>
            <p className="panel-sub">
              <StatusBadge tone={verdictTone(production_plan.verdict)}>{production_plan.verdict}</StatusBadge>{" "}
              — {production_plan.verdict_basis}
            </p>
            <table className="grid" style={{ marginBottom: 14 }}>
              <thead><tr><th>Component</th><th>Required</th><th>Available</th><th>Shortage</th></tr></thead>
              <tbody>
                {production_plan.materials.length === 0 ? (
                  <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--text-soft)" }}>No BOM found.</td></tr>
                ) : (
                  production_plan.materials.map((m) => (
                    <tr key={m.component_id}>
                      <td>{m.component_name}</td>
                      <td>{m.required}</td>
                      <td>{m.available}</td>
                      <td>{m.shortage > 0 ? <StatusBadge tone="danger">{m.shortage}</StatusBadge> : "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <table className="grid">
              <thead><tr><th>#</th><th>Operation</th><th>Work Center</th></tr></thead>
              <tbody>
                {production_plan.routing_operations.length === 0 ? (
                  <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--text-soft)" }}>No routing found.</td></tr>
                ) : (
                  production_plan.routing_operations.map((op) => (
                    <tr key={op.operation_id}>
                      <td>{op.op_number}</td>
                      <td>{op.operation}</td>
                      <td>{op.work_center_code}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      {/* 3. Schedule */}
      <Panel title="Schedule">
        {!schedule ? (
          <p style={{ fontSize: 12.5, color: "var(--text-soft)" }}>No schedule — no production order linked.</p>
        ) : (
          <table className="grid">
            <thead><tr><th>Operation</th><th>Machine</th><th>Operator</th><th>Start</th><th>End</th><th>Status</th></tr></thead>
            <tbody>
              {schedule.operations.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--text-soft)" }}>No operations scheduled.</td></tr>
              ) : (
                schedule.operations.map((op, i) => (
                  <tr key={i}>
                    <td>{op.operation}</td>
                    <td>{op.machine ?? "—"}</td>
                    <td>{op.operator ?? "—"}</td>
                    <td>{op.scheduled_start ? new Date(op.scheduled_start).toLocaleString() : "—"}</td>
                    <td>{op.scheduled_end ? new Date(op.scheduled_end).toLocaleString() : "—"}</td>
                    <td><StatusBadge tone="neutral">{op.status}</StatusBadge></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </Panel>

      {/* 4. APS Status */}
      <Panel title="APS Status">
        {!capacity ? (
          <p style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
            No capacity data — {schedule ? "APS Platform or scheduling-service may be unreachable." : "no production order linked."}
          </p>
        ) : (
          <>
            <p className="panel-sub">
              {capacity.bottlenecks.length === 0
                ? `No machine over ${capacity.bottleneck_threshold_pct}% utilized this week.`
                : `${capacity.bottlenecks.length} machine(s) at or above ${capacity.bottleneck_threshold_pct}% — a real bottleneck risk.`}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {capacity.machines.map((m) => (
                <div key={m.machineId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 60, fontSize: 12, color: "var(--text-soft)" }}>{m.machineName}</span>
                  <div style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--paper-2)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(m.loadPct, 100)}%`, background: m.loadPct >= capacity.bottleneck_threshold_pct ? "var(--alert)" : "var(--accent)" }} />
                  </div>
                  <span style={{ width: 40, fontSize: 12, color: "var(--text-soft)", textAlign: "right" }}>{m.loadPct.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>

      {/* 5. Actions — What-if is real and non-committing. Reschedule and
          Optimize are now real and committing too, built on real
          SINGLE/AFFECTED scoping (see the page-level comment above). */}
      <Panel title="Actions">
        {!schedule || work_centers.length === 0 ? (
          <p className="panel-sub" style={{ marginBottom: 0 }}>
            Actions need a linked production order and at least one real work center — neither is available for this order.
          </p>
        ) : (
          <>
            <p className="panel-sub" style={{ marginBottom: 0 }}>
              What-if is non-committing — nothing it shows writes anything. Reschedule and Optimize below are real.
            </p>
            <WhatIfForm salesOrderId={sales_order.sales_order_id} workCenters={work_centers} currentCompletion={currentCompletion || null} />
            <RescheduleActions salesOrderId={sales_order.sales_order_id} />
          </>
        )}
      </Panel>

      {missing.length > 0 && (
        <AlertBanner tone="warning" title="Not currently available">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {missing.map((m, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{m}</li>
            ))}
          </ul>
        </AlertBanner>
      )}
    </div>
  );
}
