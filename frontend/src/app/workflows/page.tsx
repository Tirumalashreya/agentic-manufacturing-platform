"use client";

import { useEffect, useMemo, useState } from "react";
import { listActiveWorkflows } from "@/lib/api";
import type { ActiveWorkflowDomain, ActiveWorkflowItem } from "@/types/workflows";
import { PageHeader, Panel, StatusBadge, AlertBanner, Button } from "@/components/ui";

const DOMAIN_LABELS: Record<ActiveWorkflowDomain, string> = {
  SALES_ORDER: "Sales Order — Credit Hold",
  PROJECT_MILESTONE: "Project Milestone",
  EXPORT_ORDER: "Export Order",
  CONSIGNMENT: "Consignment",
  SERVICE_ORDER: "Service Order",
  RETURN: "Return — Pending Inspection",
  TRADING_ORDER: "Trading Order",
};

const ALL = "ALL" as const;
const POLL_INTERVAL_MS = 5000;

export default function ActiveWorkflowsPage() {
  const [items, setItems] = useState<ActiveWorkflowItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [domainFilter, setDomainFilter] = useState<ActiveWorkflowDomain | typeof ALL>(ALL);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      const data = await listActiveWorkflows();
      setItems(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      // A background refresh failing shouldn't blank out data that's
      // already on screen and still probably accurate.
      setError(err instanceof Error ? err.message : "Could not load active workflows.");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();

    // Polling, not a websocket/SSE stream — this backend has no push
    // channel, so "realtime" here means "never more than a few seconds
    // stale," paused while the tab isn't visible so it doesn't poll a
    // screen nobody's looking at.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_INTERVAL_MS);

    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const counts = useMemo(() => {
    const c = new Map<ActiveWorkflowDomain, number>();
    for (const item of items ?? []) c.set(item.domain, (c.get(item.domain) ?? 0) + 1);
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return null;
    if (domainFilter === ALL) return items;
    return items.filter((item) => item.domain === domainFilter);
  }, [items, domainFilter]);

  const domainsPresent = useMemo(
    () => (Object.keys(DOMAIN_LABELS) as ActiveWorkflowDomain[]).filter((d) => (counts.get(d) ?? 0) > 0),
    [counts]
  );

  return (
    <>
      <PageHeader
        kicker="OPERATIONS QUEUE"
        title="Active workflows"
        description={
          <>
            Everything created through New Request that isn&apos;t finished yet — a project milestone
            waiting on sign-off, an export order mid-shipment, a return waiting on inspection, and so
            on. Financial Adjustments have their own gate on the Approvals page and aren&apos;t
            duplicated here; active Subscriptions have no pending action and don&apos;t appear either.
          </>
        }
      />

      {error && <AlertBanner tone="danger" title="Could not load workflows">{error}</AlertBanner>}

      <Panel title="In progress">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 4 }}>
          <div>
            <div className="panel-sub" style={{ marginBottom: 4 }}>
              {items === null ? "Loading..." : `${items.length} item(s) across ${domainsPresent.length} domain(s).`}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
              {refreshing
                ? "Refreshing..."
                : lastUpdated
                  ? `Live — updated ${lastUpdated.toLocaleTimeString()} · refreshes every ${POLL_INTERVAL_MS / 1000}s`
                  : ""}
            </div>
          </div>
          <Button variant="secondary" onClick={refresh} disabled={refreshing}>
            Refresh now
          </Button>
        </div>

        {items && items.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
            <button
              type="button"
              className={domainFilter === ALL ? "btn" : "btn secondary"}
              onClick={() => setDomainFilter(ALL)}
            >
              All ({items.length})
            </button>
            {domainsPresent.map((d) => (
              <button
                type="button"
                key={d}
                className={domainFilter === d ? "btn" : "btn secondary"}
                onClick={() => setDomainFilter(d)}
              >
                {DOMAIN_LABELS[d]} ({counts.get(d)})
              </button>
            ))}
          </div>
        )}

        {items && items.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--text-faint)" }}>Nothing in progress right now.</p>
        )}

        {filtered && filtered.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>ID</th>
                  <th>Customer</th>
                  <th>Summary</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={`${item.domain}-${item.id}`}>
                    <td style={{ fontSize: 12 }}>{DOMAIN_LABELS[item.domain]}</td>
                    <td className="mono">{item.id}</td>
                    <td>{item.customer_name ?? "—"}</td>
                    <td style={{ fontSize: 12.5, color: "var(--text-soft)" }}>{item.summary}</td>
                    <td className="mono">{item.amount != null ? item.amount.toLocaleString() : "—"}</td>
                    <td>
                      <StatusBadge tone="warning">{item.status ?? "UNKNOWN"}</StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
