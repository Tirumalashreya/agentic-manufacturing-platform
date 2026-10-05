import type { MachineWorkload } from "@/lib/services";

// BEAS/Proficy-style workload histogram: one bar per machine, height = real
// effectiveLoadPct (packages/domain/src/capacity-engine.ts
// computeEffectiveLoadPct) — real usage divided by a real, shift/holiday/
// break/maintenance/efficiency/availability-adjusted practical-capacity
// figure (computeEffectiveCapacity), not raw 24/7 calendar minutes. The
// scheduler's own placement logic doesn't call this (or the old loadPct) —
// placement feasibility is governed separately by real Redis bucket
// availability plus shift/holiday window-narrowing; this is a reporting
// figure for a planner deciding where to add capacity, not a placement
// input. Raw loadPct (unchanged, same raw-minutes denominator as before
// this round) is kept visible underneath for transparency — nothing hidden.
const OVERLOAD_THRESHOLD_PCT = 90;
const BAR_MAX_HEIGHT = 96;

export function WorkloadGraph({ machines }: { machines: MachineWorkload[] }) {
  if (machines.length === 0) {
    return <p className="text-sm text-muted">No machines to show workload for.</p>;
  }

  return (
    <div className="flex items-end gap-4 overflow-x-auto pb-2">
      {machines.map((m) => {
        const pct = Math.max(0, Math.min(m.effectiveLoadPct, 150)); // clamp display, real overload is still visible via color
        const barHeight = Math.max((Math.min(pct, 100) / 100) * BAR_MAX_HEIGHT, 4);
        const isOverloaded = m.effectiveLoadPct > OVERLOAD_THRESHOLD_PCT;
        const color = isOverloaded ? "bg-danger" : m.effectiveLoadPct > 70 ? "bg-warning" : "bg-brand-500";

        return (
          <div key={m.machineId} className="flex w-20 shrink-0 flex-col items-center gap-1">
            <span className="text-xs font-semibold text-foreground">{m.effectiveLoadPct.toFixed(0)}%</span>
            <div className="flex h-[96px] w-full items-end rounded-md bg-surface-muted">
              <div
                className={`w-full rounded-md transition-[height] duration-300 ${color}`}
                style={{ height: barHeight }}
              />
            </div>
            <span className="w-full truncate text-center text-[11px] text-muted" title={m.machineName}>
              {m.machineName}
            </span>
            <span className="text-[10px] text-muted" title="Raw load — used minutes over raw 24/7 calendar minutes, not practical capacity">
              {m.loadPct.toFixed(0)}% raw
            </span>
          </div>
        );
      })}
    </div>
  );
}
