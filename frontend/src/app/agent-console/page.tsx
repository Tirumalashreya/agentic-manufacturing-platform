"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  resolveSalesOrderApproval,
  resolveRescheduleApproval,
  runWorkflow,
  ApiError,
  type PendingApprovalEntry,
  type RescheduleApprovalResult,
} from "@/lib/api";
import type { SalesOrderApprovalResult, WorkflowResult } from "@/types/workflow";
import ReportModal from "@/components/reports/ReportModal";
import { TrackOrderPanel } from "@/components/manufacturing/TrackOrderPanel";
import {
  buildCreditStageReport,
  buildSalesOrderReport,
  buildStockStageReport,
  buildWorkflowReport,
  type ReportDoc,
} from "@/lib/reports";
import { nodeMeta, type NodeCategory } from "@/lib/graphNodes";
import { ExecutionTimeline } from "@/components/agent-console/ExecutionTimeline";
import { ArchitecturePanel } from "@/components/agent-console/ArchitecturePanel";
import { PageHeader, Button } from "@/components/ui";
import { RESUME_HANDOFF_KEY } from "@/app/pending-decisions/page";

const EXAMPLE =
  "Northgate Traders wants 10 Wireless Mouse units. Check their credit and stock. If everything is okay, prepare the order for my approval.";

// Discoverability pass (agreed with the user) — every prompt here maps to a
// capability confirmed real this session; none is a guess at what "should"
// work. Deliberately no bottleneck/capacity prompt: no conversational
// trigger for either currently exists (confirmed by auditing
// composed_execution_router), so suggesting one would imply a capability
// that isn't there.
const SUGGESTED_PROMPTS = [
  "What's our inventory status?",
  "Did the last batch pass quality inspection?",
  "Why is order SO0001 delayed?",
  "Reschedule SO0001",
  "Optimize the schedule for SO0001",
];

// Node labels/categories now come from lib/graphNodes.ts (discoverability
// pass, agreed with the user) — this used to be a separate, smaller (12 of
// 30 real node ids) map that silently fell back to a raw node id for
// everything else, including reschedule_request and the newer
// inventory_quality_request. One shared source of truth now, also used by
// the trace page.

// Contextual follow-ups (discoverability pass, agreed with the user) —
// same capability-gated rule as SUGGESTED_PROMPTS above, just filtered by
// what the real result actually contains rather than always showing the
// same static list. Never suggests a capability the result didn't earn.
function contextualSuggestions(result: WorkflowResult | null): string[] {
  if (!result) return [];
  const out: string[] = [];
  const orderId = result.sales_order_id;
  if (orderId) {
    out.push(`Why is ${orderId} delayed?`);
    out.push(`Reschedule ${orderId}`);
  }
  if (result.pending_approval?.preview?.production_plan?.verdict === "MATERIAL_SHORTAGE") {
    out.push("What's our inventory status?");
  }
  return out;
}

// Error status was always real and already thrown by lib/api.ts's
// ApiError — this codebase just never read it (discoverability pass,
// agreed with the user). A 5xx (or a network failure, which never even
// reaches the server to get a status) means a real service is down; a 4xx
// is the backend correctly rejecting something about the request itself.
// Conflating the two under one generic "Something went wrong" was the gap.
function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status >= 500) return `⚠ Service unavailable — ${err.message}`;
    return err.message;
  }
  if (err instanceof Error) {
    if (err.message.toLowerCase().includes("fetch")) return "⚠ Could not reach the orchestrator — it may be down.";
    return err.message;
  }
  return fallback;
}

type Msg = { role: "user" | "assistant"; text: string };

// Real gap found live, twice. First: navigating away to Production
// Planning or Execution and back used to unmount this whole page and
// throw the entire run away — fixed by persisting to localStorage.
// Second (this rework, per the user's own spec): nothing on the backend
// serializes requests either — a real plant runs several jobs at once,
// and a person watching it fields a call about order A while order B is
// still mid-approval. A single flat useState per field meant starting a
// new request always clobbered whatever the previous one was doing.
// `conversations` replaces that: each tab is its own independent run
// (messages/result/approval/etc.), switchable without losing any of
// them, and `submit()` is keyed by conversation id so two tabs can
// genuinely be in flight at once.
const SESSION_KEY = "agent-console-session";

// Approved orders stay tracked here regardless of which conversation tab
// is active or was used to approve them — a production order on the
// floor doesn't belong to a chat tab, it belongs to the session. Every
// approved order accumulates here until MAX_TRACKED_ORDERS is hit.
type TrackedOrder = {
  productionOrderId: string;
  salesOrderId: string | null;
  customerName: string;
  productName: string;
  quantity: number;
};
const MAX_TRACKED_ORDERS = 5;

type Conversation = {
  id: string;
  title: string;
  messages: Msg[];
  draft: string;
  loading: boolean;
  error: string | null;
  result: WorkflowResult | null;
  revealedCount: number;
  finalOrder: { id: string; status: string; total: number } | null;
  orderApproval: {
    context: Record<string, unknown>;
    outcome: SalesOrderApprovalResult;
    approvedAt: string;
  } | null;
  decision: "APPROVED" | "REJECTED" | null;
  preferVendor: boolean;
  // The correction mechanism (agreed with the user): if an earlier agent
  // got the quantity wrong, this is edited here rather than restarting
  // the whole request — null means "unedited, use what the pipeline
  // resolved."
  editedQuantity: number | null;
  approvalBusy: boolean;
  // Reschedule/Optimize's own small approval flow (agreed with the
  // user) — deliberately separate from orderApproval/decision above,
  // which are shaped for order creation specifically. Only ever set
  // when result.pending_approval.action === "RESCHEDULE_PRODUCTION".
  rescheduleResult: RescheduleApprovalResult | null;
  rescheduleBusy: boolean;
};

function makeConversation(): Conversation {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `c${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    title: "New request",
    messages: [],
    draft: "",
    loading: false,
    error: null,
    result: null,
    revealedCount: 0,
    finalOrder: null,
    orderApproval: null,
    decision: null,
    preferVendor: false,
    editedQuantity: null,
    approvalBusy: false,
    rescheduleResult: null,
    rescheduleBusy: false,
  };
}

function pendingLabel(entry: PendingApprovalEntry): string {
  const p = entry.pending_approval?.preview;
  if (!p) return "Pending decision";
  const parts = [p.customer_name, p.quantity ? `${p.quantity} × ${p.product_name ?? "item"}` : p.product_name].filter(Boolean);
  return parts.join(" — ") || "Pending decision";
}

// Reconstructs the exact approval screen a run was left at — not a new
// pipeline run, no new LLM calls, just the same pending_approval object
// this run already produced live. Used both by the Pending Decisions page's
// resume handoff (see the hydration effect below) and, previously, by this
// page's own now-removed inline banner.
function buildResumedConversation(entry: PendingApprovalEntry): Conversation {
  return {
    ...makeConversation(),
    title: pendingLabel(entry),
    messages: [{ role: "assistant", text: `Resumed a pending decision: ${pendingLabel(entry)}.` }],
    result: { run_id: entry.run_id, user_message: "", pending_approval: entry.pending_approval, status: "AWAITING_APPROVAL", response: entry.response },
    revealedCount: 9999,
  };
}

type PersistedSession = {
  conversations: Conversation[];
  activeConversationId: string | null;
  trackedOrders: TrackedOrder[];
};

function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null;
  }
}

function saveSession(session: PersistedSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private browsing / storage disabled — the console still works for
    // this visit, it just won't survive leaving the page.
  }
}

const TRACKED_ORDERS_KEY = "ledger-tracked-orders";

// Real bug found live: trackedOrders used to live in the same localStorage
// bundle as conversations, then (after the stale-COMPLETED-order fix) was
// deliberately never restored at all — closing the stale-resurrection bug,
// but also wiping the live tracker on every ordinary navigation away and
// back, which is clearly worse UX for something explicitly framed as "live"
// tracking during an active session. sessionStorage is the right lifetime
// for this: it survives navigation and reload within the same tab/session,
// but — unlike localStorage — is gone the next time you open a new tab or
// log back in later, so a long-finished order from a past session still
// can't resurrect.
function loadTrackedOrders(): TrackedOrder[] {
  try {
    const raw = sessionStorage.getItem(TRACKED_ORDERS_KEY);
    return raw ? (JSON.parse(raw) as TrackedOrder[]) : [];
  } catch {
    return [];
  }
}

function saveTrackedOrders(orders: TrackedOrder[]) {
  try {
    sessionStorage.setItem(TRACKED_ORDERS_KEY, JSON.stringify(orders));
  } catch {
    // Private browsing / storage disabled — tracking still works for this
    // render, it just won't survive navigating away.
  }
}

type DisplayStage = {
  key: string;
  icon: string;
  label: string;
  category: NodeCategory;
  status: "done" | "paused" | "failed";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  decision?: string;
};

// The backend runs synchronously and returns every stage at once — this
// turns that real, complete stage list into the same shape a human would
// narrate it in, splitting composed_execution's one combined output into
// the separate Credit/Stock/Approval/Order steps it actually represents
// under the hood (see plan_executor.py — those really are separate
// deterministic tool calls, just returned as one node's output). Every
// `category` below is the real architectural fact (agreed with the user,
// discoverability pass) — Credit/Stock/Order are deterministic transactions,
// not agent decisions, and are labeled that way even though they used to
// carry "Agent" in their name.
function buildDisplayStages(result: WorkflowResult, decided?: "APPROVED" | "REJECTED"): DisplayStage[] {
  const out: DisplayStage[] = [];
  for (const stage of result.stages ?? []) {
    if (stage.node === "composed_execution") {
      const o = stage.output as Record<string, unknown>;
      if (result.status === "CUSTOMER_NOT_FOUND") {
        out.push({
          key: "credit",
          icon: "⚙️",
          label: "Credit Check",
          category: "deterministic",
          status: "failed",
          decision: "⚠ Customer not on file",
        });
      } else if (o.credit_checked) {
        const within = o.credit_within_limit as boolean;
        out.push({
          key: "credit",
          icon: "⚙️",
          label: "Credit Check",
          category: "deterministic",
          status: "done",
          output: {
            existing_exposure: o.credit_existing_exposure,
            total_exposure: o.credit_total_exposure,
            within_limit: within,
          },
          decision: within ? "✓ Credit approved" : "✕ Over credit limit",
        });
      }
      if (o.stock_checked) {
        const sufficient = o.stock_sufficient as boolean;
        out.push({
          key: "stock",
          icon: "⚙️",
          label: "Stock Check",
          category: "deterministic",
          status: "done",
          output: { stock_total: o.stock_total, sufficient },
          decision: sufficient ? "✓ Stock available" : "✕ Insufficient stock",
        });
      }
      // Real APS Agent capability card (agreed with the user) — this is the
      // one place composed_execution's output already carries the richest
      // real data (materials/routing/simulated schedule/procurement), from
      // pending_approval.preview, reused here rather than re-fetched.
      const preview = result.pending_approval?.preview;
      if (preview?.fulfillment) {
        out.push({
          key: "fulfillment",
          icon: "📦",
          label: "Fulfillment Agent",
          category: "agent",
          status: "done",
          input: { product: preview.product_name, quantity: preview.quantity },
          output: { strategy: preview.fulfillment.strategy, reasoning: preview.fulfillment.reasoning },
          decision: `Strategy: ${preview.fulfillment.strategy}`,
        });
      }
      if (preview?.production_plan) {
        const pp = preview.production_plan;
        out.push({
          key: "aps_agent",
          icon: "🏭",
          label: "APS Agent — Production Feasibility",
          category: "agent",
          // Phase 2: WAITING_FOR_PRODUCTION_SLOT is a real, complete plan
          // (just placed via the scheduler's extended-horizon retry) — not
          // a failure, matches it not blocking approval below. MATERIAL_SHORTAGE
          // stays "failed"-styled here unchanged (still a real thing worth
          // flagging visually, even though it doesn't block approval either).
          status: pp.verdict === "PLANNING_CONFIGURATION_ISSUE" || pp.verdict === "PLANNER_REVIEW" || pp.verdict === "MATERIAL_SHORTAGE" ? "failed" : "done",
          input: { product: preview.product_name, quantity: preview.quantity },
          output: {
            verdict: pp.verdict,
            materials: pp.materials,
            routing_operations: pp.routing_operations,
            simulated_operations: pp.simulated_operations,
            procurement_plan: pp.procurement_plan,
          },
          decision: pp.explanation,
        });
      }
      if (result.pending_approval) {
        out.push({
          key: "approval",
          icon: decided === "APPROVED" ? "✓" : decided === "REJECTED" ? "✕" : "⏸",
          label: "Human Approval",
          category: "human",
          status: decided === "APPROVED" ? "done" : decided === "REJECTED" ? "failed" : "paused",
          decision:
            decided === "APPROVED" ? "✓ Approved" : decided === "REJECTED" ? "✕ Rejected" : "Awaiting your decision",
        });
      } else if (o.sales_order_id) {
        out.push({
          key: "order",
          icon: "🧾",
          label: "Order Created",
          category: "deterministic",
          status: "done",
          output: {
            sales_order_id: o.sales_order_id,
            status: o.sales_order_status,
            total: o.sales_order_total,
          },
          decision: "✓ Order created",
        });
      } else if (result.status === "CUSTOMER_NOT_FOUND") {
        out.push({ key: "order", icon: "✕", label: "Order Held", category: "deterministic", status: "failed", decision: "✕ Held — customer not found" });
      } else if (result.status === "ON_CREDIT_HOLD") {
        out.push({ key: "order", icon: "⏸", label: "Order Held", category: "deterministic", status: "failed", decision: "✕ Held — credit hold" });
      } else if (o.stock_checked && !o.stock_sufficient) {
        out.push({ key: "order", icon: "⏸", label: "Order Held", category: "deterministic", status: "failed", decision: "✕ Held — insufficient stock" });
      } else if (o.credit_checked && !o.credit_within_limit) {
        out.push({ key: "order", icon: "⏸", label: "Order Held", category: "deterministic", status: "failed", decision: "✕ Held — over credit limit" });
      }
      continue;
    }

    const meta = nodeMeta(stage.node);
    out.push({ key: stage.node, icon: meta.icon, label: meta.label, category: meta.category, status: "done", output: stage.output });
  }
  return out;
}

// Fulfillment and billing genuinely run as their own agents too (see
// run_post_approval_fulfillment / billing_agent in graph.py) — they just
// happen inside the separate approval-resolve call, not the original
// /pipeline/runs stream buildDisplayStages reads from above. Without this,
// the pipeline list visually stopped at Human Approval and the O2C flow's
// own "Cash" half (billing) never appeared as a step, only as text buried
// in the final order-summary card.
function buildPostApprovalStages(outcome: SalesOrderApprovalResult | undefined): DisplayStage[] {
  if (!outcome?.fulfillment_strategy) return [];
  const out: DisplayStage[] = [];

  const failed = outcome.fulfillment_status === "FULFILLMENT_FAILED";
  const inProgress = outcome.fulfillment_status === "IN_PRODUCTION" || outcome.fulfillment_status === "AWAITING_MATERIALS";
  const needsAction = outcome.fulfillment_status === "PENDING_MANUAL_ACTION";
  // Deterministic execution of the strategy the Fulfillment Agent already
  // decided pre-approval (see buildDisplayStages' "fulfillment" card, the
  // real LLM decision) — this card is the real commit/execution result,
  // not a second agent decision, labeled accordingly.
  out.push({
    key: "fulfillment_execution",
    icon: "⚙️",
    label: "Fulfillment Execution",
    category: "deterministic",
    status: failed ? "failed" : inProgress || needsAction ? "paused" : "done",
    output: { strategy: outcome.fulfillment_strategy, reasoning: outcome.fulfillment_reasoning, status: outcome.fulfillment_status },
    decision: failed
      ? "✕ Fulfillment failed"
      : needsAction
      ? "⚠ Needs manual handling"
      : inProgress
      ? `⏳ ${outcome.fulfillment_status} — not shipped yet`
      : `✓ ${outcome.fulfillment_strategy}`,
  });

  if (outcome.production_order_id) {
    out.push({
      key: "production_planning",
      icon: "🏭",
      label: "APS Agent — Production Release",
      category: "deterministic",
      status: "done",
      output: {
        production_order_id: outcome.production_order_id,
        scheduled_operations: outcome.scheduled_operations,
      },
      decision: `✓ Released — ${outcome.scheduled_operations?.length ?? 0} operation(s) scheduled`,
    });
  }

  if (outcome.purchase_orders && outcome.purchase_orders.length > 0) {
    // Real per-component vendor selection (Phase 7) — deterministic, not
    // an LLM tradeoff on this path. No "Procurement Agent" card exists
    // because no such chat-reachable agent runs here (confirmed this
    // session) — labeled as the real deterministic capability it is.
    out.push({
      key: "procurement",
      icon: "⚙️",
      label: "Procurement — Purchase Orders",
      category: "deterministic",
      status: "done",
      output: { purchase_orders: outcome.purchase_orders },
      decision: `✓ ${outcome.purchase_orders.length} purchase order(s) placed`,
    });
  }

  if (outcome.delivery_id) {
    out.push({
      key: "delivery",
      icon: "🚚",
      label: "Delivery Schedule",
      category: "deterministic",
      status: "done",
      output: { delivery_id: outcome.delivery_id, status: outcome.delivery_status, confirmed_delivery_date: outcome.confirmed_delivery_date },
      decision: outcome.confirmed_delivery_date ? `✓ Confirmed ${outcome.confirmed_delivery_date}` : `✓ ${outcome.delivery_status}`,
    });
  }

  if (outcome.invoice_id) {
    out.push({
      key: "billing",
      icon: "💰",
      label: "Billing Agent",
      category: "agent",
      status: "done",
      output: { delivery_id: outcome.delivery_id, invoice_id: outcome.invoice_id, invoice_amount: outcome.invoice_amount, invoice_status: outcome.invoice_status },
      decision: `✓ Invoiced ${outcome.invoice_amount?.toLocaleString()}`,
    });
  }

  return out;
}

function StageCard({ stage, revealed, onReport }: { stage: DisplayStage; revealed: boolean; onReport?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        border: `1px solid ${stage.status === "paused" ? "var(--gold)" : "var(--line)"}`,
        background: stage.status === "paused" ? "var(--gold-soft)" : "var(--card)",
        borderRadius: 6,
        marginBottom: 10,
        opacity: revealed ? 1 : 0,
        transform: revealed ? "translateY(0)" : "translateY(6px)",
        transition: "opacity 300ms ease, transform 300ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: "transparent",
          border: "none",
          cursor: stage.output ? "pointer" : "default",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <span style={{ fontSize: 16 }}>{stage.icon}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>
          {stage.label}
          <span
            title={
              stage.category === "agent"
                ? "An LLM call, reasoning over real facts computed elsewhere — never inventing them"
                : stage.category === "deterministic"
                ? "Real calculation or transaction — no LLM involved"
                : stage.category === "human"
                ? "Waiting on your decision — nothing executes without it"
                : "Control flow — no LLM, no calculation"
            }
            style={{
              marginLeft: 7,
              fontSize: 9,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              padding: "1px 5px",
              borderRadius: 3,
              border: "1px solid var(--line)",
              color: "var(--text-faint)",
              verticalAlign: "middle",
            }}
          >
            {stage.category === "agent" ? "LLM" : stage.category === "deterministic" ? "Deterministic" : stage.category === "human" ? "Human Gate" : "Routing"}
          </span>
        </span>
        {stage.decision && (
          <span
            className={`chip ${stage.status === "failed" ? "bad" : stage.status === "paused" ? "warn" : "ok"}`}
            style={{ fontSize: 10.5 }}
          >
            {stage.decision}
          </span>
        )}
        {stage.output && <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{open ? "▲" : "▼"}</span>}
      </button>
      {onReport && (
        <button
          type="button"
          onClick={onReport}
          className="btn secondary"
          style={{ padding: "5px 10px", fontSize: 11, marginRight: 10, whiteSpace: "nowrap" }}
        >
          📄 Report
        </button>
      )}
      </div>
      {open && stage.output && (
        <pre
          style={{
            margin: 0,
            padding: "10px 14px 12px",
            fontSize: 11,
            borderTop: "1px solid var(--line)",
            overflowX: "auto",
            color: "var(--text-soft)",
          }}
        >
          {JSON.stringify(stage.output, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function AgentConsolePage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [trackedOrders, setTrackedOrders] = useState<TrackedOrder[]>([]);
  const [activeReport, setActiveReport] = useState<ReportDoc | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();

  // Two runs used to be able to overlap and stomp each other's state —
  // the Send button's disabled={loading} only stopped a click, and
  // Enter bypassed it entirely. Now that submits are genuinely
  // concurrent across tabs, the same guard has to be per-conversation
  // and can't rely on a state read that might be one render stale — a
  // plain mutable Set, checked and updated synchronously at the start
  // and end of submit(), can't race the way a useState read could.
  const busyRef = useRef<Set<string>>(new Set());

  // Restore a session left behind by navigating away, once, on mount.
  // Runs after the empty initial render rather than as useState's lazy
  // initializer so it stays server/client-render identical (no
  // hydration mismatch) — localStorage doesn't exist on the server at
  // all. `hydrated` guards the save effect below from a real race:
  // without it, the save effect's first run (right after this one, same
  // mount) would still see the pre-restore, still-empty state and write
  // that straight back over whatever was just loaded, permanently.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const draftParam = searchParams.get("draft");

    // Pending Decisions (its own page now, not a banner here — see
    // pending-decisions/page.tsx) hands off a run to resume via
    // sessionStorage rather than a query param, since the full entry
    // (context/preview, not just an id) is what resumeRun needs to
    // reconstruct the approval screen without re-fetching or re-running
    // anything.
    let resumedConv: Conversation | null = null;
    try {
      const raw = sessionStorage.getItem(RESUME_HANDOFF_KEY);
      if (raw) {
        const entry = JSON.parse(raw) as PendingApprovalEntry;
        if (entry?.pending_approval) resumedConv = buildResumedConversation(entry);
        sessionStorage.removeItem(RESUME_HANDOFF_KEY);
      }
    } catch {
      // malformed/unavailable handoff — nothing to resume, not an error
    }

    const saved = loadSession();
    if (saved && saved.conversations && saved.conversations.length > 0) {
      // A tab persisted mid "loading: true" (page closed during a run)
      // would otherwise come back permanently stuck and unresubmittable
      // — busyRef starts empty on a fresh mount, so resetting loading
      // here keeps the two in sync.
      let convs = saved.conversations.map((c) => ({ ...c, loading: false, revealedCount: 9999 }));
      let activeId = saved.activeConversationId ?? convs[0].id;
      if (draftParam) {
        const draftConv = { ...makeConversation(), draft: draftParam };
        convs = [...convs, draftConv];
        activeId = draftConv.id;
      }
      if (resumedConv) {
        convs = [...convs, resumedConv];
        activeId = resumedConv.id;
      }
      setConversations(convs);
      setActiveConversationId(activeId);
    } else {
      const conv = makeConversation();
      if (draftParam) conv.draft = draftParam;
      const convs = resumedConv ? [conv, resumedConv] : [conv];
      setConversations(convs);
      setActiveConversationId(resumedConv ? resumedConv.id : conv.id);
    }
    // sessionStorage, not localStorage — survives navigating away and back
    // within this tab/session (the actual bug report: the tracker going
    // blank after visiting another page) without resurrecting a stale
    // order from a past login (the original bug this replaced).
    setTrackedOrders(loadTrackedOrders());
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveSession({ conversations, activeConversationId, trackedOrders });
    saveTrackedOrders(trackedOrders);
  }, [hydrated, conversations, activeConversationId, trackedOrders]);

  function patchConversation(id: string, patch: Partial<Conversation> | ((c: Conversation) => Partial<Conversation>)) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c))
    );
  }

  function newConversation() {
    const conv = makeConversation();
    setConversations((prev) => [...prev, conv]);
    setActiveConversationId(conv.id);
  }

  function closeConversation(id: string) {
    const remaining = conversations.filter((c) => c.id !== id);
    const next = remaining.length > 0 ? remaining : [makeConversation()];
    setConversations(next);
    if (activeConversationId === id) {
      setActiveConversationId(next[next.length - 1].id);
    }
  }

  const activeConversation = conversations.find((c) => c.id === activeConversationId) ?? null;

  const activeDisplayStages = activeConversation?.result
    ? buildDisplayStages(activeConversation.result, activeConversation.decision ?? undefined)
    : [];
  const activePostApprovalStages = buildPostApprovalStages(activeConversation?.orderApproval?.outcome);
  const allStages = [...activeDisplayStages, ...activePostApprovalStages];
  const activeRevealedCount = activeConversation?.revealedCount ?? 0;

  useEffect(() => {
    if (!activeConversationId) return;
    if (activeRevealedCount >= allStages.length) return;
    const timer = setTimeout(() => {
      patchConversation(activeConversationId, (c) => ({ revealedCount: c.revealedCount + 1 }));
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, activeRevealedCount, allStages.length]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversationId, activeConversation?.messages, activeConversation?.result]);

  async function submit(conversationId: string, text: string) {
    if (!text.trim() || busyRef.current.has(conversationId)) return;
    busyRef.current.add(conversationId);
    patchConversation(conversationId, (c) => ({
      messages: [...c.messages, { role: "user", text }],
      title: c.messages.length === 0 ? (text.length > 44 ? `${text.slice(0, 44)}…` : text) : c.title,
      draft: "",
      loading: true,
      error: null,
      result: null,
      finalOrder: null,
      orderApproval: null,
      decision: null,
      preferVendor: false,
      editedQuantity: null,
      revealedCount: 0,
      rescheduleResult: null,
      rescheduleBusy: false,
    }));
    try {
      const data = await runWorkflow(text);
      patchConversation(conversationId, (c) => ({
        result: data,
        messages: [...c.messages, { role: "assistant", text: data.response ?? data.clarification_question ?? "Done." }],
      }));
    } catch (err) {
      patchConversation(conversationId, { error: describeError(err, "Something went wrong.") });
    } finally {
      busyRef.current.delete(conversationId);
      patchConversation(conversationId, { loading: false });
    }
  }

  async function decide(conversationId: string, newDecision: "APPROVED" | "REJECTED") {
    const conv = conversations.find((c) => c.id === conversationId);
    if (!conv?.result?.pending_approval) return;
    // The server refuses to hand back a pending_approval it couldn't
    // durably record (see pipeline.py's start_run) — so a real
    // pending_approval always has a real run_id. This guard is here for
    // TypeScript's benefit (run_id is nullable in the general case), not
    // because this should ever actually be null.
    if (!conv.result.run_id) {
      patchConversation(conversationId, { error: "This run has no recorded id — cannot approve." });
      return;
    }
    patchConversation(conversationId, { approvalBusy: true, decision: newDecision });
    // Approval State hardening: the server now owns the real approval
    // payload (see db.save_pending_approval) — only run_id and the one
    // legitimate edit-before-approving field (quantity) go over the wire.
    // If the quantity was corrected on the approval card, that edited
    // value — not the original agent-resolved one — is what actually
    // gets created. total_amount is recomputed server-side from this.
    const approvalContext =
      conv.editedQuantity !== null
        ? { ...conv.result.pending_approval.context, quantity: conv.editedQuantity }
        : conv.result.pending_approval.context;
    try {
      const outcome = await resolveSalesOrderApproval(conv.result.run_id, newDecision, conv.editedQuantity, conv.preferVendor);
      if (outcome.created && outcome.sales_order_id) {
        const fulfillmentNote = outcome.fulfillment_strategy
          ? ` Fulfillment: ${outcome.fulfillment_strategy}${outcome.invoice_id ? ` — delivered and invoiced (${outcome.invoice_id}).` : "."}`
          : "";
        patchConversation(conversationId, (c) => ({
          finalOrder: {
            id: outcome.sales_order_id!,
            status: outcome.sales_order_status ?? "CONFIRMED",
            total: outcome.sales_order_total ?? 0,
          },
          orderApproval: { context: approvalContext, outcome, approvedAt: new Date().toLocaleString() },
          messages: [...c.messages, { role: "assistant", text: `Order ${outcome.sales_order_id} created.${fulfillmentNote}` }],
        }));
        if (outcome.production_order_id) {
          const ctx = approvalContext as { customer_name?: string; product_name?: string; quantity?: number };
          const newEntry: TrackedOrder = {
            productionOrderId: outcome.production_order_id,
            salesOrderId: outcome.sales_order_id ?? null,
            customerName: ctx.customer_name ?? "Customer",
            productName: ctx.product_name ?? "Product",
            quantity: ctx.quantity ?? 0,
          };
          setTrackedOrders((prev) =>
            [newEntry, ...prev.filter((o) => o.productionOrderId !== newEntry.productionOrderId)].slice(0, MAX_TRACKED_ORDERS)
          );
        }
      } else {
        patchConversation(conversationId, (c) => ({
          messages: [...c.messages, { role: "assistant", text: "Order not created — rejected." }],
        }));
      }
    } catch (err) {
      patchConversation(conversationId, { error: describeError(err, "Approval failed.") });
    } finally {
      patchConversation(conversationId, { approvalBusy: false });
    }
  }

  // Reschedule/Optimize's own approval handler (agreed with the user) —
  // deliberately separate from decide() above, which is order-creation
  // shaped. Converges on the exact same backend call the Ledger UI
  // button uses (resolveRescheduleApproval -> mfg.reschedule_production_order),
  // so this is genuinely just a second entry point into one
  // authoritative implementation, not a parallel one.
  async function decideReschedule(conversationId: string, newDecision: "APPROVED" | "REJECTED") {
    const conv = conversations.find((c) => c.id === conversationId);
    if (!conv?.result?.pending_approval || conv.result.pending_approval.action !== "RESCHEDULE_PRODUCTION") return;
    if (!conv.result.run_id) {
      patchConversation(conversationId, { error: "This run has no recorded id — cannot approve." });
      return;
    }
    patchConversation(conversationId, { rescheduleBusy: true });
    try {
      const outcome = await resolveRescheduleApproval(conv.result.run_id, newDecision);
      const summary =
        outcome.status === "REJECTED"
          ? "Reschedule request rejected — nothing was changed."
          : `${outcome.kind === "optimize" ? "Optimize" : "Reschedule"} committed — scope ${outcome.scope}. ${outcome.ordersProcessed ?? 0} order(s) actually rescheduled, ${outcome.operationsScheduled ?? 0} operation(s) scheduled.`;
      patchConversation(conversationId, (c) => ({
        rescheduleResult: outcome,
        messages: [...c.messages, { role: "assistant", text: summary }],
      }));
    } catch (err) {
      patchConversation(conversationId, { error: describeError(err, "Reschedule failed.") });
    } finally {
      patchConversation(conversationId, { rescheduleBusy: false });
    }
  }

  const preview = activeConversation?.result?.pending_approval?.preview;
  const editedQuantity = activeConversation?.editedQuantity ?? null;
  const preferVendor = activeConversation?.preferVendor ?? false;
  const result = activeConversation?.result ?? null;

  // Recomputed live from real data already in the response — no new
  // backend call needed to react to an edited quantity. Mirrors exactly
  // what credit_tools.check_credit / plan_executor.check_stock compute
  // server-side, so this can never silently disagree with the real gate.
  const effectiveQuantity = editedQuantity ?? preview?.quantity ?? 0;
  const unitPrice = preview?.unit_price ?? 0;
  const effectiveEstimatedValue = effectiveQuantity * unitPrice;
  const existingExposure = (result?.credit_existing_exposure as number | undefined) ?? 0;
  const creditLimit = result?.pending_approval?.context.customer_credit_limit as number | undefined;
  const newTotalExposure = existingExposure + effectiveEstimatedValue;
  const creditStillOk = creditLimit === undefined || newTotalExposure <= creditLimit;
  const stockArray = (result?.pending_approval?.context.stock as { stock_qty: number }[] | undefined) ?? [];
  const stockTotal = stockArray.reduce((a, s) => a + (s.stock_qty ?? 0), 0);
  const stockStillOk = stockTotal >= effectiveQuantity;
  const quantityEdited = editedQuantity !== null && editedQuantity !== preview?.quantity;

  // Planning-before-approval: a real blocking verdict from the manufacturing
  // services blocks Approve the same way insufficient credit does — the
  // human sees exactly why, same pattern as creditStillOk above.
  const productionVerdict = preview?.production_plan?.verdict;
  // MATERIAL_SHORTAGE doesn't block — approving now also places real
  // purchase orders for the shortfall (see the procurement plan shown
  // below), so "produce this" and "order what's missing" happen together.
  // PLANNING_CONFIGURATION_ISSUE blocks — no BOM/routing/master-data
  // mapping exists at all, genuinely nothing to approve.
  // PLANNER_REVIEW blocks — the scheduler tried its own extended-horizon
  // retry too and still couldn't place every operation; no complete plan
  // exists to approve.
  // WAITING_FOR_PRODUCTION_SLOT does NOT block (Phase 2's whole point) —
  // every operation IS placed, just beyond the normal horizon; it's a
  // real, complete plan with real dates, ready for the normal approve →
  // commit flow same as any other valid plan.
  const productionPlanBlocksApproval =
    productionVerdict === "PLANNING_CONFIGURATION_ISSUE" || productionVerdict === "PLANNER_REVIEW";

  function statusDot(c: Conversation): string {
    if (c.loading) return "⏳";
    if (c.result?.pending_approval?.action === "RESCHEDULE_PRODUCTION") return c.rescheduleResult ? "✓" : "⏸";
    if (c.result?.pending_approval && !c.decision) return "⏸";
    if (c.finalOrder) return "✓";
    if (c.error) return "✕";
    return "";
  }

  return (
    <>
      <PageHeader
        kicker="AGENTIC AI DEMO"
        title="Sales Order Orchestrator"
        description="Talk to the Sales Order AI while watching it orchestrate the real pipeline — Intent → Understanding → Entity Resolution → Process Decision → Credit → Stock → Human Approval → Order Creation. Every stage below is the real agent output, not a simulation. Every tab below is an independent, concurrent run — starting or approving one never waits on another."
      />

      {/* CONVERSATION TABS */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto", marginBottom: 12, paddingBottom: 2 }}>
        {conversations.map((c) => {
          const isActive = c.id === activeConversationId;
          return (
            <div key={c.id} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setActiveConversationId(c.id)}
                className="btn secondary"
                style={{
                  fontSize: 11.5,
                  padding: "6px 10px",
                  borderTopRightRadius: 0,
                  borderBottomRightRadius: 0,
                  background: isActive ? "var(--accent)" : undefined,
                  color: isActive ? "#FFFFFF" : undefined,
                  maxWidth: 200,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={c.title}
              >
                {statusDot(c) && <span style={{ marginRight: 5 }}>{statusDot(c)}</span>}
                {c.title}
              </button>
              <button
                type="button"
                onClick={() => closeConversation(c.id)}
                aria-label={`Close ${c.title}`}
                className="btn secondary"
                style={{
                  fontSize: 11,
                  padding: "6px 8px",
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  borderLeft: "1px solid var(--line)",
                  background: isActive ? "var(--accent)" : undefined,
                  color: isActive ? "#FFFFFF" : undefined,
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button type="button" onClick={newConversation} className="btn secondary" style={{ fontSize: 11.5, padding: "6px 12px", flexShrink: 0 }}>
          + New
        </button>
      </div>

      <ArchitecturePanel />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 22, alignItems: "start" }}>
        {/* CHAT */}
        <div className="panel" style={{ display: "flex", flexDirection: "column", height: 560 }}>
          <div className="panel-title" style={{ marginBottom: 0 }}>Chat</div>
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, marginBottom: 12, marginTop: 10 }}>
            {activeConversation && activeConversation.messages.length === 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button type="button" className="btn secondary" style={{ textAlign: "left" }} onClick={() => activeConversationId && submit(activeConversationId, EXAMPLE)}>
                  Try: &ldquo;{EXAMPLE}&rdquo;
                </button>
                <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>Or ask about a real order/capability:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="btn secondary"
                      style={{ fontSize: 11.5, padding: "4px 10px" }}
                      onClick={() => activeConversationId && submit(activeConversationId, prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {activeConversation?.messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  background: m.role === "user" ? "var(--accent)" : "var(--paper-2)",
                  color: m.role === "user" ? "#FFFFFF" : "var(--text)",
                  padding: "9px 13px",
                  borderRadius: 10,
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {m.text}
              </div>
            ))}
            {activeConversation?.loading && (
              <div style={{ alignSelf: "flex-start", fontSize: 12, color: "var(--text-faint)" }}>
                Agent is working…
              </div>
            )}
            {!activeConversation?.loading &&
              (activeConversation?.messages.length ?? 0) > 0 &&
              contextualSuggestions(result ?? null).length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignSelf: "flex-start" }}>
                  {contextualSuggestions(result ?? null).map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="btn secondary"
                      style={{ fontSize: 11, padding: "4px 9px" }}
                      onClick={() => activeConversationId && submit(activeConversationId, prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            <div ref={chatEndRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (activeConversationId && activeConversation) submit(activeConversationId, activeConversation.draft);
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input
              value={activeConversation?.draft ?? ""}
              onChange={(e) => activeConversationId && patchConversation(activeConversationId, { draft: e.target.value })}
              placeholder="Describe what the customer needs…"
              style={{
                flex: 1,
                border: "1px solid var(--line-strong)",
                borderRadius: 5,
                padding: "9px 10px",
                fontSize: 13,
                background: "var(--paper)",
                color: "var(--text)",
              }}
            />
            <button type="submit" className="btn" disabled={!activeConversationId || !!activeConversation?.loading}>
              Send
            </button>
          </form>
        </div>

        {/* LIVE PIPELINE */}
        <div className="panel" style={{ minHeight: 560 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div className="panel-title">Live Agent Pipeline</div>
              <div className="panel-sub">
                {result ? `${allStages.length} stage(s)` : "Send a request to see the pipeline run."}
              </div>
            </div>
            {result && activeDisplayStages.length > 0 && (
              <button
                type="button"
                className="btn secondary"
                style={{ padding: "6px 12px", fontSize: 11.5, whiteSpace: "nowrap" }}
                onClick={() => setActiveReport(buildWorkflowReport(result, allStages))}
              >
                📄 Workflow Report
              </button>
            )}
          </div>

          {activeConversation?.error && (
            <p style={{ color: "var(--alert)", fontSize: 12.5 }}>{activeConversation.error}</p>
          )}

          {allStages.map((stage, i) => (
            <StageCard
              key={stage.key}
              stage={stage}
              revealed={i < activeRevealedCount}
              onReport={
                stage.key === "credit"
                  ? () => setActiveReport(buildCreditStageReport(result!))
                  : stage.key === "stock"
                  ? () => setActiveReport(buildStockStageReport(result!))
                  : undefined
              }
            />
          ))}

          {result && activeRevealedCount >= activeDisplayStages.length && activeDisplayStages.length > 0 && (
            <ExecutionTimeline runId={result.run_id} />
          )}

          {activeConversation &&
            result?.pending_approval?.action === "RESCHEDULE_PRODUCTION" &&
            activeRevealedCount >= activeDisplayStages.length &&
            !activeConversation.rescheduleResult && (
              <div className="clarify-card" style={{ marginTop: 4 }}>
                <div className="panel-title">
                  ⏸ {result.pending_approval.preview.kind === "optimize" ? "Optimize" : "Reschedule"} Approval Required
                </div>
                <p
                  className="mono"
                  style={{ fontSize: 10, color: "var(--text-faint)", letterSpacing: 0.3, margin: "2px 0 6px" }}
                >
                  APS AGENT RECOMMENDS → HUMAN APPROVES → DETERMINISTIC SCHEDULING ENGINE EXECUTES
                </p>
                <p className="panel-sub" style={{ marginBottom: 10 }}>
                  Real and committing once approved. Nothing has changed yet.
                </p>
                <div className="kv-grid" style={{ marginBottom: 14 }}>
                  <div className="kv">
                    <div className="kv-label">SALES ORDER</div>
                    <div className="kv-value" style={{ fontSize: 15 }}>{result.pending_approval.preview.sales_order_id}</div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">SCOPE</div>
                    <div className="kv-value" style={{ fontSize: 15 }}>{result.pending_approval.preview.scope}</div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">AFFECTED ORDERS</div>
                    <div className="kv-value" style={{ fontSize: 15 }}>
                      {(result.pending_approval.preview.affected_count ?? 0) > 0
                        ? `This order + ${result.pending_approval.preview.affected_count} other(s) sharing its work centers`
                        : "This order only"}
                    </div>
                  </div>
                </div>
                <div className="btn-row" style={{ marginTop: 0 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={activeConversation.rescheduleBusy}
                    onClick={() => activeConversationId && decideReschedule(activeConversationId, "APPROVED")}
                  >
                    ✓ Approve
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={activeConversation.rescheduleBusy}
                    onClick={() => activeConversationId && decideReschedule(activeConversationId, "REJECTED")}
                  >
                    ✕ Reject
                  </button>
                </div>
              </div>
            )}

          {activeConversation &&
            result?.pending_approval &&
            result.pending_approval.action !== "RESCHEDULE_PRODUCTION" &&
            activeRevealedCount >= activeDisplayStages.length &&
            !activeConversation.finalOrder && (
            <div
              className="clarify-card"
              style={{ marginTop: 4 }}
            >
              <div className="panel-title">⏸ Human Approval Required</div>
              <p
                className="mono"
                style={{ fontSize: 10, color: "var(--text-faint)", letterSpacing: 0.3, margin: "2px 0 6px" }}
              >
                AGENT RECOMMENDS → HUMAN APPROVES → DETERMINISTIC SERVICE EXECUTES
              </p>
              <p className="panel-sub" style={{ marginBottom: 10 }}>
                The AI has completed validation. Nothing has been created yet.
              </p>
              <div className="kv-grid" style={{ marginBottom: 14 }}>
                <div className="kv">
                  <div className="kv-label">CUSTOMER</div>
                  <div className="kv-value" style={{ fontSize: 15 }}>{preview?.customer_name}</div>
                </div>
                <div className="kv">
                  <div className="kv-label">PRODUCT</div>
                  <div className="kv-value" style={{ fontSize: 15 }}>{preview?.product_name}</div>
                </div>
                <div className="kv">
                  <div className="kv-label">QUANTITY — EDITABLE IF THE AI GOT THIS WRONG</div>
                  <input
                    type="number"
                    min={1}
                    value={effectiveQuantity}
                    onChange={(e) => activeConversationId && patchConversation(activeConversationId, { editedQuantity: Math.max(1, Number(e.target.value) || 1) })}
                    style={{
                      width: "100%", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600,
                      color: "var(--text)", background: "var(--card)", border: "1px solid var(--line-strong)",
                      borderRadius: 5, padding: "5px 8px", marginTop: 3,
                    }}
                  />
                </div>
                <div className="kv">
                  <div className="kv-label">ORDER VALUE</div>
                  <div className="kv-value" style={{ fontSize: 15 }}>{effectiveEstimatedValue.toLocaleString()}</div>
                </div>
              </div>

              {quantityEdited && (
                <p style={{ fontSize: 11.5, marginBottom: 14, color: creditStillOk ? "var(--text-soft)" : "var(--alert)" }}>
                  {creditStillOk
                    ? `Rechecked against the corrected quantity — still within credit${stockStillOk ? " and stock" : ", though stock alone won't cover this (fulfillment will still handle it)"}.`
                    : `⚠ At ${effectiveQuantity} units this would push exposure to ${newTotalExposure.toLocaleString()}, over the ${creditLimit?.toLocaleString()} limit — approval is disabled until you lower the quantity.`}
                </p>
              )}

              {preview?.fulfillment && (
                <div style={{ marginBottom: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                  <div className="kv-label" style={{ marginBottom: 6 }}>
                    FULFILLMENT: {preview.fulfillment.strategy}
                  </div>
                  <p style={{ fontSize: 11.5, color: "var(--text-soft)", margin: "0 0 10px" }}>
                    {preview.fulfillment.reasoning}
                  </p>

                  {preview.production_plan && (
                    <div style={{ marginBottom: 4 }}>
                      {/* Phase 2 (agreed with the user): a business-readable
                          banner for the three states that used to collapse
                          into one raw "UNPLANNABLE" word — each is a
                          genuinely different situation needing a different
                          human action, not the same failure. */}
                      {preview.production_plan.verdict === "WAITING_FOR_PRODUCTION_SLOT" && (() => {
                        const ops = preview.production_plan!.simulated_operations;
                        const start = ops.length > 0 ? new Date(Math.min(...ops.map((o) => new Date(o.scheduled_start).getTime()))) : null;
                        const end = ops.length > 0 ? new Date(Math.max(...ops.map((o) => new Date(o.scheduled_end).getTime()))) : null;
                        return (
                          <div style={{ padding: "10px 12px", borderRadius: 6, background: "var(--card-2)", border: "1px solid var(--gold)", marginBottom: 10 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--gold)", marginBottom: 6 }}>⏳ WAITING FOR PRODUCTION SLOT</div>
                            <div style={{ fontSize: 11.5, color: "var(--text-soft)", marginBottom: 6 }}>
                              Materials: Available ✓ &nbsp;·&nbsp; Production capacity: Waiting
                            </div>
                            <div className="kv-grid" style={{ marginBottom: 6 }}>
                              <div className="kv">
                                <div className="kv-label">TENTATIVE PRODUCTION START</div>
                                <div className="kv-value" style={{ fontSize: 13 }}>{start ? start.toLocaleString() : "—"}</div>
                              </div>
                              <div className="kv">
                                <div className="kv-label">TENTATIVE COMPLETION</div>
                                <div className="kv-value" style={{ fontSize: 13 }}>{end ? end.toLocaleString() : "—"}</div>
                              </div>
                            </div>
                            <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0 }}>
                              No feasible production slot is currently available within the current schedule — this is the
                              next real slot the scheduler could find. This is a valid, complete plan; approving proceeds normally.
                            </p>
                          </div>
                        );
                      })()}
                      {preview.production_plan.verdict === "PLANNER_REVIEW" && (
                        <div style={{ padding: "10px 12px", borderRadius: 6, background: "var(--card-2)", border: "1px solid var(--alert)", marginBottom: 10 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--alert)", marginBottom: 6 }}>⚑ PLANNER REVIEW REQUIRED</div>
                          <p style={{ fontSize: 11.5, color: "var(--text-soft)", margin: 0 }}>
                            No feasible production slot was found within the supported planning horizon.
                          </p>
                        </div>
                      )}
                      {preview.production_plan.verdict === "PLANNING_CONFIGURATION_ISSUE" && (
                        <div style={{ padding: "10px 12px", borderRadius: 6, background: "var(--card-2)", border: "1px solid var(--alert)", marginBottom: 10 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--alert)", marginBottom: 6 }}>⚠ PLANNING CONFIGURATION ISSUE</div>
                          <p style={{ fontSize: 11.5, color: "var(--text-soft)", margin: 0 }}>{preview.production_plan.explanation}</p>
                        </div>
                      )}

                      <span
                        className={`chip ${
                          preview.production_plan.verdict === "PASS"
                            ? "ok"
                            : preview.production_plan.verdict === "WARNING" || preview.production_plan.verdict === "WAITING_FOR_PRODUCTION_SLOT"
                            ? "warn"
                            : "bad"
                        }`}
                        style={{ fontSize: 10.5, marginBottom: 8, display: "inline-block" }}
                      >
                        {preview.production_plan.verdict === "PASS"
                          ? "✓"
                          : preview.production_plan.verdict === "WARNING" || preview.production_plan.verdict === "WAITING_FOR_PRODUCTION_SLOT"
                          ? "⚠"
                          : "✕"}{" "}
                        {preview.production_plan.verdict}
                      </span>
                      <p style={{ fontSize: 11.5, color: "var(--text-soft)", margin: "0 0 10px" }}>
                        {preview.production_plan.explanation}
                      </p>

                      {preview.production_plan.materials.length > 0 && (
                        <table className="grid" style={{ marginBottom: 10 }}>
                          <tbody>
                            {preview.production_plan.materials.map((m) => (
                              <tr key={m.component_name}>
                                <td className="mono">{m.component_name}</td>
                                <td>{m.required} required</td>
                                <td>{m.available} available</td>
                                <td>
                                  <span className={`chip ${m.shortage > 0 ? "bad" : "ok"}`} style={{ fontSize: 10 }}>
                                    {m.shortage > 0 ? `SHORTAGE ${m.shortage}` : "PASS"}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {preview.production_plan.simulated_operations.length > 0 && (
                        <table className="grid">
                          <tbody>
                            {preview.production_plan.simulated_operations.map((op, i) => (
                              <tr key={i}>
                                <td className="mono">{op.operation}</td>
                                <td className="mono">{op.machine_name}</td>
                                <td style={{ fontSize: 10.5 }}>
                                  {new Date(op.scheduled_start).toLocaleTimeString()} – {new Date(op.scheduled_end).toLocaleTimeString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {preview.production_plan.procurement_plan.length > 0 && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--line)" }}>
                          <div className="kv-label" style={{ marginBottom: 6 }}>
                            SUGGESTED PROCUREMENT — APPROVING WILL ALSO ORDER THESE
                          </div>
                          <table className="grid">
                            <tbody>
                              {preview.production_plan.procurement_plan.map((line) => (
                                <tr key={line.component_name}>
                                  <td className="mono">{line.component_name}</td>
                                  <td>{line.quantity} units</td>
                                  <td>from {line.vendor_name}</td>
                                  <td style={{ fontSize: 10.5 }}>expected {new Date(line.expected_date).toLocaleDateString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {preview.vendor_plan?.vendors_available && (
                    <p style={{ fontSize: 11.5, color: "var(--text-soft)", margin: 0 }}>
                      Sourced from <strong>{preview.vendor_plan.vendor_name}</strong> ({preview.vendor_plan.strategy_label}). {preview.vendor_plan.reasoning}
                    </p>
                  )}
                </div>
              )}

              {preview?.vendor_available && (() => {
                const ops = preview.production_plan?.simulated_operations ?? [];
                const readyDate = ops.length > 0
                  ? new Date(Math.max(...ops.map((o) => new Date(o.scheduled_end).getTime()))).toLocaleDateString()
                  : null;
                const vendorDate = preview.vendor_plan?.target_completion_date
                  ? new Date(preview.vendor_plan.target_completion_date).toLocaleDateString()
                  : null;
                return (
                  <div style={{ marginBottom: 14 }}>
                    <div className="kv-label" style={{ marginBottom: 8 }}>
                      FULFILLMENT — NOTHING IN STOCK, HOW SHOULD THIS BE MADE? (BOTH PLANNED BELOW)
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" checked={!preferVendor} onChange={() => activeConversationId && patchConversation(activeConversationId, { preferVendor: false })} style={{ marginTop: 2 }} />
                        <span>
                          <strong>Option A — Produce in-house</strong> (recommended)
                          {preview.production_plan?.verdict && (
                            <span className={`chip ${preview.production_plan.verdict === "PASS" ? "ok" : "bad"}`} style={{ marginLeft: 8, fontSize: 10 }}>
                              {preview.production_plan.verdict}
                            </span>
                          )}
                          <br />
                          <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
                            {readyDate ? `Ready ${readyDate}` : "Schedule not available"}
                          </span>
                        </span>
                      </label>
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" checked={preferVendor} onChange={() => activeConversationId && patchConversation(activeConversationId, { preferVendor: true })} style={{ marginTop: 2 }} />
                        <span>
                          <strong>Option B — Source from {preview.vendor_plan?.vendor_name ?? preview.vendor_names?.join(", ")}</strong>
                          <br />
                          <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
                            {vendorDate
                              ? `Arriving ${vendorDate} (${preview.vendor_plan?.lead_time_days} day lead time)`
                              : "Lead time not available"}
                          </span>
                        </span>
                      </label>
                    </div>
                  </div>
                );
              })()}

              <div className="btn-row" style={{ marginTop: 0 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={activeConversation.approvalBusy || !creditStillOk || productionPlanBlocksApproval}
                  onClick={() => activeConversationId && decide(activeConversationId, "APPROVED")}
                >
                  {(preview?.production_plan?.procurement_plan.length ?? 0) > 0 ? "✓ Approve Order + Procurement" : "✓ Approve Order"}
                </button>
                <button type="button" className="btn secondary" disabled={activeConversation.approvalBusy} onClick={() => activeConversationId && decide(activeConversationId, "REJECTED")}>
                  ✕ Reject
                </button>
              </div>
            </div>
          )}

          {activeConversation?.rescheduleResult && (
            <div className="panel" style={{ background: "var(--money-soft)", border: "1.6px solid var(--money)", marginTop: 4 }}>
              <div className="panel-title" style={{ color: "var(--money)" }}>
                {activeConversation.rescheduleResult.status === "REJECTED"
                  ? "✕ Reschedule Rejected"
                  : `✓ ${activeConversation.rescheduleResult.kind === "optimize" ? "Optimize" : "Reschedule"} Committed`}
              </div>
              {activeConversation.rescheduleResult.status !== "REJECTED" && (
                <table className="grid" style={{ marginTop: 6 }}>
                  <tbody>
                    <tr><td className="mono">Sales Order</td><td className="mono">{activeConversation.rescheduleResult.sales_order_id}</td></tr>
                    <tr><td className="mono">Scope</td><td>{activeConversation.rescheduleResult.scope}</td></tr>
                    <tr><td className="mono">Orders rescheduled</td><td>{activeConversation.rescheduleResult.ordersProcessed}</td></tr>
                    <tr><td className="mono">Operations scheduled</td><td>{activeConversation.rescheduleResult.operationsScheduled}</td></tr>
                  </tbody>
                </table>
              )}
            </div>
          )}

          {activeConversation?.finalOrder && (
            <div className="panel" style={{ background: "var(--money-soft)", border: "1.6px solid var(--money)", marginTop: 4 }}>
              <div className="panel-title" style={{ color: "var(--money)" }}>✓ Sales Order Created</div>
              <table className="grid" style={{ marginTop: 6 }}>
                <tbody>
                  <tr><td className="mono">Order</td><td className="mono">{activeConversation.finalOrder.id}</td></tr>
                  <tr><td className="mono">Status</td><td>{activeConversation.finalOrder.status}</td></tr>
                  <tr><td className="mono">Value</td><td>{activeConversation.finalOrder.total.toLocaleString()}</td></tr>
                </tbody>
              </table>

              {/* Fulfillment + billing outcomes now render as their own
                  Fulfillment Agent / Billing Agent stage rows above (see
                  buildPostApprovalStages) instead of being duplicated here. */}

              {activeConversation.orderApproval && (
                <button
                  type="button"
                  className="btn secondary"
                  style={{ marginTop: 14, padding: "6px 12px", fontSize: 11.5 }}
                  onClick={() =>
                    setActiveReport(
                      buildSalesOrderReport(
                        activeConversation.orderApproval!.context,
                        activeConversation.orderApproval!.outcome,
                        activeConversation.orderApproval!.approvedAt
                      )
                    )
                  }
                >
                  📄 Sales Order Report
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {trackedOrders.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title">Orders On The Floor</div>
          <p className="panel-sub" style={{ marginBottom: 12 }}>
            Tracked independently of any chat tab — approving a new order while these are still in
            production doesn&apos;t wait for them; each tracks on its own.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {trackedOrders.map((order) => (
              <TrackOrderPanel
                key={order.productionOrderId}
                productionOrderId={order.productionOrderId}
                salesOrderId={order.salesOrderId}
                customerName={order.customerName}
                productName={order.productName}
                quantity={order.quantity}
                onGone={() =>
                  setTrackedOrders((prev) => prev.filter((o) => o.productionOrderId !== order.productionOrderId))
                }
              />
            ))}
          </div>
        </div>
      )}

      {activeReport && <ReportModal report={activeReport} onClose={() => setActiveReport(null)} />}
    </>
  );
}
