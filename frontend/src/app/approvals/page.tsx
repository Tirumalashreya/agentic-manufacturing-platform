"use client";

import { useEffect, useState } from "react";
import { listFinancialApprovals, postFinancialApproval, resolveFinancialApproval } from "@/lib/api";
import type { FinancialAdjustment } from "@/types/approvals";
import { PageHeader, Panel, StatusBadge, AlertBanner, Button } from "@/components/ui";

const STATUS_TONE: Record<FinancialAdjustment["status"], "warning" | "success" | "danger" | "neutral"> = {
  PENDING_APPROVAL: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  POSTED: "neutral",
};

export default function ApprovalsPage() {
  const [items, setItems] = useState<FinancialAdjustment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actingAs, setActingAs] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await listFinancialApprovals());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load approvals.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        kicker="HUMAN-IN-THE-LOOP"
        title="Approvals"
        description={
          <>
            Financial adjustments at or above the auto-approval threshold stop here before they
            post. This is the only approval gate wired into the live workflow today — other
            domains&apos; post-creation steps (milestone sign-off, shipment, sale reporting, ...)
            aren&apos;t approval gates and don&apos;t appear here.
          </>
        }
      />

      <Panel title="Acting as" subtitle="Recorded against whatever you approve or reject — there's no login system yet, so this is a free-text identity.">
        <div className="field" style={{ maxWidth: 260 }}>
          <input value={actingAs} onChange={(e) => setActingAs(e.target.value)} placeholder="e.g. finance_lead" />
        </div>
      </Panel>

      {error && <AlertBanner tone="danger" title="Action failed">{error}</AlertBanner>}

      <Panel title="Pending action" subtitle={items === null ? "Loading..." : `${items.length} adjustment(s) need a decision or a post.`}>

        {items && items.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--text-faint)" }}>Nothing needs attention right now.</p>
        )}

        {items && items.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.financial_adjustment_id}>
                    <td className="mono">{item.financial_adjustment_id}</td>
                    <td>{item.adjustment_type}</td>
                    <td>{item.customer_name ?? item.customer_id ?? "—"}</td>
                    <td className="mono">{item.amount.toLocaleString()}</td>
                    <td style={{ maxWidth: 260, fontSize: 12.5, color: "var(--text-soft)" }}>{item.reason}</td>
                    <td>
                      <StatusBadge tone={STATUS_TONE[item.status]}>{item.status}</StatusBadge>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 8 }}>
                        {item.status === "PENDING_APPROVAL" && (
                          <>
                            <Button
                              disabled={busyId === item.financial_adjustment_id}
                              onClick={() =>
                                act(item.financial_adjustment_id, () =>
                                  resolveFinancialApproval(item.financial_adjustment_id, "APPROVED", actingAs || "SYSTEM")
                                )
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={busyId === item.financial_adjustment_id}
                              onClick={() =>
                                act(item.financial_adjustment_id, () =>
                                  resolveFinancialApproval(item.financial_adjustment_id, "REJECTED", actingAs || "SYSTEM")
                                )
                              }
                            >
                              Reject
                            </Button>
                          </>
                        )}
                        {item.status === "APPROVED" && (
                          <Button
                            disabled={busyId === item.financial_adjustment_id}
                            onClick={() => act(item.financial_adjustment_id, () => postFinancialApproval(item.financial_adjustment_id))}
                          >
                            Post
                          </Button>
                        )}
                      </div>
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
