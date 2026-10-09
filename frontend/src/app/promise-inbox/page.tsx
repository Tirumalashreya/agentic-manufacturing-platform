"use client";

import { useEffect, useMemo, useState } from "react";
import {
  listPromiseInbox,
  type PromiseInboxItem,
  type PromiseInboxResponse,
  type PromiseRiskStatus,
  type PromiseWorkflowStatus,
} from "@/lib/api";
import { formatDate } from "@/lib/promiseUi";
import {
  PageHeader,
  Panel,
  MetricGrid,
  MetricCard,
  StatusBadge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Button,
  type Column,
  type StatusTone,
} from "@/components/ui";

// Phase 14 (Promise Risk & Decision Inbox) — one planner workspace
// answering: which promises are at risk, why, which decisions need
// attention first, and what the planner can do about it. Everything here
// is a GET: opening, searching, filtering, or refreshing this page can
// never execute a consequential action (no approval/execution call lives
// anywhere in this file) — see src/lib/api.ts's listPromiseInbox and,
// upstream, services/order-service/src/promise-inbox.ts +
// packages/domain/src/promise-risk.ts for where riskStatus/workflowStatus
// actually get decided (never here, and never by an LLM).
//
// Fetched once with a generous limit and filtered/sorted entirely
// client-side — same convention every other channel page in this app
// already uses (none of them filter server-side either) — so the summary
// counts always reflect the full real population, never the narrowed
// table a search or filter is currently showing.

const RISK_TONE: Record<PromiseRiskStatus, StatusTone> = {
  BREACHED: "danger",
  AT_RISK: "warning",
  UNKNOWN: "neutral",
  SAFE: "success",
};

const WORKFLOW_LABEL: Record<PromiseWorkflowStatus, string> = {
  NONE: "—",
  AWAITING_APPROVAL: "Awaiting approval",
  RECOVERY_VERIFIED_RESTORED: "Recovery verified — restored",
  RECOVERY_VERIFIED_FAILED: "Recovery verified — not restored",
};
const WORKFLOW_TONE: Record<PromiseWorkflowStatus, StatusTone> = {
  NONE: "neutral",
  AWAITING_APPROVAL: "warning",
  RECOVERY_VERIFIED_RESTORED: "success",
  RECOVERY_VERIFIED_FAILED: "danger",
};

const RISK_FILTERS: PromiseRiskStatus[] = ["BREACHED", "AT_RISK", "UNKNOWN", "SAFE"];

type SortKey = "priority" | "promisedDate" | "delayHours" | "customerName";

function formatDelay(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export default function PromiseInboxPage() {
  const [data, setData] = useState<PromiseInboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState<Set<PromiseRiskStatus>>(new Set(RISK_FILTERS));
  const [pendingApprovalOnly, setPendingApprovalOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  // Same shape as pending-decisions/page.tsx's own fetch effect — no
  // synchronous setState before the promise settles, so the initial load
  // and a manual refresh share one code path without tripping the
  // set-state-in-effect rule (refreshing is only ever set synchronously
  // from the Refresh button's own click handler, never from this effect).
  function fetchInbox() {
    return listPromiseInbox()
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the promise inbox."));
  }

  useEffect(() => {
    fetchInbox();
  }, []);

  function handleRefresh() {
    setRefreshing(true);
    fetchInbox().finally(() => setRefreshing(false));
  }

  function toggleRisk(status: PromiseRiskStatus) {
    setRiskFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  const visibleItems = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    let items = data.items.filter((item) => {
      if (!riskFilter.has(item.riskStatus)) return false;
      if (pendingApprovalOnly && item.workflowStatus !== "AWAITING_APPROVAL") return false;
      if (q) {
        const haystack = `${item.orderNumber ?? ""} ${item.externalOrderId ?? ""} ${item.customerName}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    if (sortKey !== "priority") {
      items = [...items].sort((a, b) => {
        let cmp = 0;
        if (sortKey === "promisedDate") cmp = new Date(a.promisedDate).getTime() - new Date(b.promisedDate).getTime();
        else if (sortKey === "delayHours") cmp = (a.delayHours ?? -1) - (b.delayHours ?? -1);
        else if (sortKey === "customerName") cmp = a.customerName.localeCompare(b.customerName);
        return cmp * sortDir;
      });
    }
    // "priority" keeps the backend's own deterministic ordering
    // (comparePromisePriority — breached first, then at-risk, etc.), only
    // ever reversible, never re-derived here.
    else if (sortDir === -1) {
      items = [...items].reverse();
    }
    return items;
  }, [data, search, riskFilter, pendingApprovalOnly, sortKey, sortDir]);

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === 1 ? " ▲" : " ▼";
  }

  const sortButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    cursor: "pointer",
    color: "var(--accent)",
  };

  function actionFor(item: PromiseInboxItem) {
    if (item.workflowStatus === "AWAITING_APPROVAL") {
      return (
        <Button variant="secondary" href="/pending-decisions">
          Review approval →
        </Button>
      );
    }
    if (item.externalOrderId) {
      return (
        <Button variant="secondary" href={`/domestic-sales/${item.externalOrderId}`}>
          View order →
        </Button>
      );
    }
    return <span style={{ fontSize: 12, color: "var(--text-faint)" }}>—</span>;
  }

  const columns: Column<PromiseInboxItem>[] = [
    {
      key: "risk",
      header: "Risk",
      render: (item) => <StatusBadge tone={RISK_TONE[item.riskStatus]}>{item.riskStatus.replace("_", " ")}</StatusBadge>,
    },
    {
      key: "order",
      header: "Order",
      render: (item) =>
        item.externalOrderId ? (
          <span className="mono">{item.externalOrderId}</span>
        ) : (
          <span className="mono" style={{ color: "var(--text-faint)" }}>
            {item.orderNumber ?? "—"}
          </span>
        ),
    },
    { key: "customer", header: "Customer", render: (item) => item.customerName },
    { key: "product", header: "Product", render: (item) => item.productSummary || "—" },
    { key: "promised", header: "Promised", render: (item) => formatDate(item.promisedDate) },
    { key: "projected", header: "Projected", render: (item) => formatDate(item.projectedDeliveryDate) },
    { key: "delay", header: "Delay", render: (item) => formatDelay(item.delayHours) },
    {
      key: "reason",
      header: "Reason",
      render: (item) => (
        <div>
          <span style={{ fontSize: 12 }}>{item.explanation}</span>
          {/* Phase 15 — evidence freshness, shown next to the reason it
              backs: a reason code alone doesn't tell a planner whether the
              schedule data behind it is from a minute ago or a stale read
              from before a disruption. Only rendered when there's real
              schedule evidence to date at all (null for a pure-stock
              promise, where there's genuinely nothing to date). */}
          {item.scheduleAsOf && (
            <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 2 }}>
              {`Schedule evidence as of ${formatDate(item.scheduleAsOf)}`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "workflow",
      header: "Recovery / Approval",
      render: (item) => <StatusBadge tone={WORKFLOW_TONE[item.workflowStatus]}>{WORKFLOW_LABEL[item.workflowStatus]}</StatusBadge>,
    },
    {
      key: "recommended",
      header: "Recommended action",
      render: (item) => <span style={{ fontSize: 12, color: "var(--text-soft)" }}>{item.recommendedAction}</span>,
    },
    { key: "act", header: "", render: (item) => actionFor(item) },
  ];

  return (
    <>
      <PageHeader
        kicker="WORK"
        title="Promise Risk & Decision Inbox"
        description="Every active customer promise, classified by real current schedule evidence — not by a model's guess. Risk and recovery/approval status are tracked separately: a promise can be breached while its recovery still waits on your approval."
        actions={
          <Button variant="secondary" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {error && <ErrorState title="Could not load the promise inbox" description={error} />}

      {!data && !error && <LoadingState label="Loading promise risk data…" />}

      {data && (
        <>
          <MetricGrid>
            <MetricCard
              label="Breached"
              value={data.summary.breached}
              note="Projected delivery is already after the promise"
              tone={data.summary.breached > 0 ? "danger" : "neutral"}
            />
            <MetricCard
              label="At risk"
              value={data.summary.atRisk}
              note="A credible operational signal threatens the promise"
              tone={data.summary.atRisk > 0 ? "warning" : "neutral"}
            />
            <MetricCard
              label="Awaiting approval"
              value={data.summary.awaitingApproval}
              note="Recovery recommendation needs your decision"
              tone={data.summary.awaitingApproval > 0 ? "warning" : "neutral"}
            />
            <MetricCard
              label="Restored after recovery"
              value={data.summary.restoredAfterRecovery}
              note="Verified post-execution — not a simulation"
              tone={data.summary.restoredAfterRecovery > 0 ? "success" : "neutral"}
            />
          </MetricGrid>

          <Panel
            title="Filters"
            subtitle={`Data as of ${new Date(data.generatedAt).toLocaleString()} — ${data.total} active promise(s) tracked.`}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search order or customer…"
                style={{ minWidth: 220 }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {RISK_FILTERS.map((status) => (
                  <label key={status} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={riskFilter.has(status)} onChange={() => toggleRisk(status)} />
                    {status.replace("_", " ")}
                  </label>
                ))}
              </div>
              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={pendingApprovalOnly} onChange={(e) => setPendingApprovalOnly(e.target.checked)} />
                Awaiting approval only
              </label>
            </div>
          </Panel>

          <Panel>
            <div style={{ display: "flex", gap: 10, marginBottom: 10, fontSize: 11.5 }}>
              <span style={{ color: "var(--text-faint)" }}>Sort:</span>
              <button style={sortButtonStyle} onClick={() => toggleSort("priority")}>
                Priority{sortArrow("priority")}
              </button>
              <button style={sortButtonStyle} onClick={() => toggleSort("promisedDate")}>
                Promised date{sortArrow("promisedDate")}
              </button>
              <button style={sortButtonStyle} onClick={() => toggleSort("delayHours")}>
                Delay{sortArrow("delayHours")}
              </button>
              <button style={sortButtonStyle} onClick={() => toggleSort("customerName")}>
                Customer{sortArrow("customerName")}
              </button>
            </div>
            {visibleItems.length === 0 ? (
              <EmptyState
                title={data.items.length === 0 ? "No active promises to track" : "No promises match these filters"}
                description={
                  data.items.length === 0
                    ? "Every tracked order is either fully delivered or has no committed promise date yet."
                    : "Try widening the risk filter or clearing the search."
                }
              />
            ) : (
              <DataTable columns={columns} rows={visibleItems} rowKey={(item) => item.salesOrderId} />
            )}
          </Panel>
        </>
      )}
    </>
  );
}
