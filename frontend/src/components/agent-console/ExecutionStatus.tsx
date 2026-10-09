import { StatusBadge, type StatusTone } from "@/components/ui";

// Phase 12 (brief §6) — a small, explicit execution-state indicator.
// Deliberately only 4 states, each with its own label/tone — never
// inferred from "the HTTP call didn't throw." The caller (page.tsx)
// passes "executing" while its own approvalBusy/rescheduleBusy flag is
// true, and "completed"/"failed" from the REAL backend outcome (e.g. a
// 502 from a failed reschedule_production_order call maps to "failed",
// not "completed" just because the request round-tripped).
export type ExecutionState = "approved" | "executing" | "completed" | "failed";

const STATE_META: Record<ExecutionState, { label: string; tone: StatusTone }> = {
  approved: { label: "Approved", tone: "neutral" },
  executing: { label: "Executing…", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Execution Failed", tone: "danger" },
};

// The step sequence actually shown for each state — a failure truncates
// the sequence right after "Approved" rather than showing a dangling,
// never-reached "Completed" badge.
const SEQUENCE: Record<ExecutionState, ExecutionState[]> = {
  approved: ["approved"],
  executing: ["approved", "executing"],
  completed: ["approved", "completed"],
  failed: ["approved", "failed"],
};

export function ExecutionStatus({ state }: { state: ExecutionState }) {
  const steps = SEQUENCE[state];
  return (
    <div data-testid="execution-status" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {steps.map((step, i) => (
        <span key={step} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusBadge tone={STATE_META[step].tone}>{STATE_META[step].label}</StatusBadge>
          {i < steps.length - 1 && <span style={{ color: "var(--text-faint)", fontSize: 12 }}>→</span>}
        </span>
      ))}
    </div>
  );
}
