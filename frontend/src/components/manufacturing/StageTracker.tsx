import { StatusBadge } from "@/components/ui";

// One horizontal stepper per production order, using the real
// ProductionOrderStatus enum (packages/domain/prisma/schema.prisma) —
// DRAFT/PLANNED -> RELEASED -> IN_PROGRESS -> COMPLETED, with CANCELLED
// as a separate terminal state shown as a single red badge instead of a
// step position. Deliberately just those 4 real forward stages: this
// page is Plan, not Execute — per-operation detail (which machine, which
// operator, Start/Complete) lives on the Execution page, this is only
// "where does this order sit right now."
const STAGES = [
  { key: "PLANNED", label: "Planned" },
  { key: "RELEASED", label: "Released" },
  { key: "IN_PROGRESS", label: "In Production" },
  { key: "COMPLETED", label: "Completed" },
] as const;

function stageIndex(status: string): number {
  if (status === "DRAFT") return 0; // DRAFT and PLANNED render as the same first step — both mean "not yet released"
  const i = STAGES.findIndex((s) => s.key === status);
  return i === -1 ? 0 : i;
}

export function StageTracker({ status, doneOps, totalOps }: { status: string; doneOps: number; totalOps: number }) {
  if (status === "CANCELLED") {
    return <StatusBadge tone="danger">CANCELLED</StatusBadge>;
  }

  const current = stageIndex(status);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      {STAGES.map((stage, i) => {
        const reached = i <= current;
        const isCurrent = i === current;
        return (
          <div key={stage.key} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 74 }}>
              <div
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: reached ? (isCurrent ? "var(--accent)" : "var(--money)") : "var(--line-strong)",
                  boxShadow: isCurrent ? "0 0 0 3px var(--accent-soft)" : "none",
                  flex: "none",
                }}
              />
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: isCurrent ? 700 : 500,
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                  color: reached ? (isCurrent ? "var(--accent)" : "var(--text-soft)") : "var(--text-faint)",
                  textAlign: "center",
                  whiteSpace: "nowrap",
                }}
              >
                {stage.label}
                {stage.key === "IN_PROGRESS" && isCurrent && totalOps > 0 ? ` ${doneOps}/${totalOps}` : ""}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div
                style={{
                  width: 20,
                  height: 2,
                  marginBottom: 14,
                  background: i < current ? "var(--money)" : "var(--line-strong)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
