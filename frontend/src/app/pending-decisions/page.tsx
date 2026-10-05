"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listPendingApprovals, type PendingApprovalEntry } from "@/lib/api";
import { PageHeader, Panel, EmptyState, Button } from "@/components/ui";

// A real gap found live (agreed with the user): this list used to live as
// a banner embedded at the top of Agent Console, mixed in with whatever
// conversation someone was actively having — every visit to Agent Console
// showed it, whether or not there was anything left to decide, and there
// was no way to see it without also loading the whole console. This is
// the same real data (agent-orchestrator's GET /pipeline/pending, now
// correctly filtered to genuinely PENDING approvals — see db.py's
// list_pending_approvals), just given its own page. "Resume" hands the
// entry off via sessionStorage and opens it as a normal conversation tab
// in Agent Console — the same reconstruction Agent Console already does
// for its own resumeRun, just triggered from here.
export const RESUME_HANDOFF_KEY = "ledger-resume-pending-decision";

function label(entry: PendingApprovalEntry): string {
  const p = entry.pending_approval?.preview;
  if (!p) return "Pending decision";
  const parts = [
    p.customer_name,
    p.quantity ? `${p.quantity} × ${p.product_name ?? "item"}` : p.product_name,
  ].filter(Boolean);
  return parts.join(" — ") || "Pending decision";
}

export default function PendingDecisionsPage() {
  const router = useRouter();
  const [items, setItems] = useState<PendingApprovalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPendingApprovals()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load pending decisions."));
  }, []);

  function resume(entry: PendingApprovalEntry) {
    try {
      sessionStorage.setItem(RESUME_HANDOFF_KEY, JSON.stringify(entry));
    } catch {
      // sessionStorage unavailable — Agent Console will just show nothing to resume
    }
    router.push("/agent-console");
  }

  return (
    <>
      <PageHeader
        kicker="WORK"
        title="Pending Decisions"
        description="Runs left sitting at a human approval gate — from before a session reset, a navigation away, or simply not getting to it yet. Nothing here has been re-run or changed; resuming opens it in Agent Console exactly where it was left."
      />

      {error && (
        <Panel>
          <p style={{ fontSize: 13, color: "var(--alert)" }}>{error}</p>
        </Panel>
      )}

      {!items && !error && (
        <Panel>
          <p style={{ fontSize: 13, color: "var(--text-soft)" }}>Loading…</p>
        </Panel>
      )}

      {items && items.length === 0 && (
        <EmptyState title="Nothing pending" description="Every run has been approved, rejected, or expired. New ones will show up here as they happen." />
      )}

      {items && items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((entry) => (
            <Panel key={entry.run_id}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{label(entry)}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>
                    {entry.pending_approval?.action === "RESCHEDULE_PRODUCTION" ? "Reschedule/Optimize" : "Order creation"}
                    {" · "}
                    {new Date(entry.created_at).toLocaleString()}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => resume(entry)}>
                  Resume →
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
