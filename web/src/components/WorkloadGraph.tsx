import type { MachineWorkload } from "@/lib/services";

// BEAS/Proficy-style workload histogram: one bar per machine, height = real
// load_pct from the capacity engine (packages/domain/src/capacity-engine.ts
// computeLoadPct — the same function the scheduler itself uses to decide
// what's overloaded), not a separate/simplified estimate.
const OVERLOAD_THRESHOLD_PCT = 90;
const BAR_MAX_HEIGHT = 96;

export function WorkloadGraph({ machines }: { machines: MachineWorkload[] }) {
  if (machines.length === 0) {
    return <p className="text-sm text-muted">No machines to show workload for.</p>;
  }

  return (
    <div className="flex items-end gap-4 overflow-x-auto pb-2">
      {machines.map((m) => {
        const pct = Math.max(0, Math.min(m.loadPct, 150)); // clamp display, real overload is still visible via color
        const barHeight = Math.max((Math.min(pct, 100) / 100) * BAR_MAX_HEIGHT, 4);
        const isOverloaded = m.loadPct > OVERLOAD_THRESHOLD_PCT;
        const color = isOverloaded ? "bg-red-500" : m.loadPct > 70 ? "bg-orange-400" : "bg-brand-500";

        return (
          <div key={m.machineId} className="flex w-20 shrink-0 flex-col items-center gap-1">
            <span className="text-xs font-semibold text-foreground">{m.loadPct.toFixed(0)}%</span>
            <div className="flex h-[96px] w-full items-end rounded-md bg-surface-muted">
              <div
                className={`w-full rounded-md transition-[height] duration-300 ${color}`}
                style={{ height: barHeight }}
              />
            </div>
            <span className="w-full truncate text-center text-[11px] text-muted" title={m.machineName}>
              {m.machineName}
            </span>
          </div>
        );
      })}
    </div>
  );
}
