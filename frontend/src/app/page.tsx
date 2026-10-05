"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  listActiveWorkflows,
  listConsignmentSales,
  listDomesticSalesOrders,
  listExportSalesOrders,
  listFinancialApprovals,
  listProjectSales,
  listReturns,
  listServicesSalesOrders,
  listTradingOrders,
} from "@/lib/api";
import { PageHeader, Panel, MetricCard, MetricGrid, ErrorState, Button } from "@/components/ui";

type ChannelMetric = { code: string; title: string; href: string; count: number; value: number; currency: string };

const money = (n: number, currency = "₹") =>
  `${currency}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function Dashboard() {
  const [channels, setChannels] = useState<ChannelMetric[] | null>(null);
  const [openItems, setOpenItems] = useState<number | null>(null);
  const [openValue, setOpenValue] = useState<number | null>(null);
  const [approvalsPending, setApprovalsPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [domestic, exportOrders, services, returns, consignment, project, trading, active, approvals] =
          await Promise.all([
            listDomesticSalesOrders(),
            listExportSalesOrders(),
            listServicesSalesOrders(),
            listReturns(),
            listConsignmentSales(),
            listProjectSales(),
            listTradingOrders(),
            listActiveWorkflows(),
            listFinancialApprovals(),
          ]);
        if (cancelled) return;

        const sum = (nums: (number | null | undefined)[]): number =>
          nums.reduce((a: number, b) => a + (b ?? 0), 0);

        setChannels([
          { code: "DOM·01", title: "Domestic Sales", href: "/domestic-sales", count: domestic.length, value: sum(domestic.map((r) => r.total_amount)), currency: "₹" },
          {
            code: "EXP·02",
            title: "Export Sales",
            href: "/export-sales",
            count: exportOrders.length,
            // Same rupee product-master price as every other channel — this
            // backend has no currency conversion anywhere, so labeling this
            // "$" would be a fabricated distinction, not a real one.
            value: sum(exportOrders.map((r) => r.total_value)),
            currency: "₹",
          },
          { code: "SVC·03", title: "Services Sales", href: "/services-sales", count: services.length, value: sum(services.map((r) => r.estimated_amount)), currency: "₹" },
          { code: "RET·04", title: "Returns", href: "/returns", count: returns.length, value: sum(returns.map((r) => r.amount)), currency: "₹" },
          { code: "CON·05", title: "Consignment Sales", href: "/consignment-sales", count: consignment.length, value: sum(consignment.map((r) => r.quantity_remaining * (r.unit_price ?? 0))), currency: "₹" },
          { code: "PRJ·06", title: "Project Sales", href: "/project-sales", count: project.length, value: sum(project.map((r) => r.contract_value)), currency: "₹" },
          { code: "TRD·07", title: "Trading", href: "/trading", count: trading.length, value: sum(trading.map((r) => r.total_cost)), currency: "₹" },
        ]);

        setOpenItems(active.length);
        setOpenValue(active.reduce((a, r) => a + (r.amount ?? 0), 0));
        setApprovalsPending(approvals.length);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load dashboard data.");
      }
    }

    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      <PageHeader
        kicker="SALES OPERATIONS"
        title="Command centre"
        description="One view across every channel the business sells through. Every number below is read live from the ERP — nothing here is a mockup figure."
      />

      {error && <ErrorState title="Could not load live data" description={error} />}

      <Panel title="Why ten flows, one AI">
        <p className="panel-sub" style={{ marginBottom: 0 }}>
          A business doesn&apos;t sell one way. The same company ships stock it already has, builds
          custom orders, sources things it can&apos;t make from a vendor, ships internationally with
          customs paperwork, sells labor with no product involved, runs milestone-billed contracts,
          lets partners sell stock on consignment, and unwinds the occasional return — ten genuinely
          different real processes, each with its own correct sequence of steps. Normally that means
          ten different forms and ten people deciding by hand which one applies.
          <br />
          <br />
          Every page below is proof, not a menu: each one shows the AI in Agent Console correctly
          classifying a plain-English request into the right process and running its real steps —
          not a generic one. The chat is the product; these tables are the receipts.
        </p>
      </Panel>

      <MetricGrid>
        <MetricCard label="Open items" value={openItems ?? "—"} note="Needs a human decision or next step" />
        <MetricCard label="Open pipeline value" value={openValue !== null ? money(openValue) : "—"} note="Sum of open items' ₹ value" />
        <MetricCard
          label="Approvals pending"
          value={approvalsPending ?? "—"}
          note={
            approvalsPending ? (
              <Link href="/approvals" style={{ color: "var(--gold)", fontWeight: 600 }}>
                Review now →
              </Link>
            ) : (
              "Nothing waiting"
            )
          }
        />
        <MetricCard label="Total records, all channels" value={channels ? channels.reduce((a, c) => a + c.count, 0) : "—"} note="Across all 7 sales channels" />
      </MetricGrid>

      <div className="panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, background: "var(--accent-soft)", borderColor: "var(--accent)" }}>
        <div>
          <div className="panel-title">Start a new request</div>
          <div className="panel-sub" style={{ marginBottom: 0 }}>
            Describe what the customer needs — watch every agent&apos;s step in real time, with a
            human approval gate before anything is created.
          </div>
        </div>
        <Button href="/agent-console" className="flex-none">
          Open Agent Console →
        </Button>
      </div>

      {channels && channels.some((c) => c.count > 0) && (
        <Panel title="Activity by channel" subtitle="Share of created records across every channel, by count — a volume view, distinct from the ₹ value shown on each channel card below.">
          {(() => {
            const totalCount = channels.reduce((a, c) => a + c.count, 0) || 1;
            const ranked = [...channels].sort((a, b) => b.count - a.count);
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
                {ranked.map((c) => (
                  <div key={c.code}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 5 }}>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{c.title}</span>
                      <span className="mono" style={{ color: "var(--text-soft)" }}>
                        {c.count} · {Math.round((c.count / totalCount) * 100)}%
                      </span>
                    </div>
                    <div className="bar-track">
                      <div
                        className="bar-fill money"
                        style={{ width: `${Math.max(2, Math.round((c.count / totalCount) * 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Panel>
      )}

      <div className="panel-title" style={{ marginBottom: 2 }}>
        Business flows
      </div>
      <div className="panel-sub" style={{ marginBottom: 14 }}>
        Each tile is a live channel — record count and total value, straight from the ERP.
      </div>
      {/* One restrained accent (the primary indigo) across every tile now,
      not a 7-color rainbow (design-system pass, agreed with the user) —
      the prior version used 7 saturated neon hues per channel purely to
      tell tiles apart, which reads as a generic dashboard template rather
      than a premium product; the code/title text already distinguishes
      channels without needing a color-per-channel scheme. */}
      <div className="tile-grid">
        {(channels ?? []).map((c) => (
          <Link className="tile" key={c.code} href={c.href}>
            <div className="tile-code">{c.code}</div>
            <div className="tile-title">{c.title}</div>
            <div className="tile-metrics">
              <div>
                <div className="tile-metric-value">{c.count}</div>
                <div className="tile-metric-label">RECORDS</div>
              </div>
              <div>
                <div className="tile-metric-value">{money(c.value, c.currency)}</div>
                <div className="tile-metric-label">VALUE</div>
              </div>
            </div>
          </Link>
        ))}
        {!channels &&
          !error &&
          Array.from({ length: 7 }).map((_, i) => (
            <div className="tile" key={i} style={{ opacity: 0.4 }}>
              <div className="tile-code">···</div>
              <div className="tile-title">Loading…</div>
            </div>
          ))}
      </div>
    </>
  );
}
