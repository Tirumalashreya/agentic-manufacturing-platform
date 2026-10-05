"use client";

import { useMemo, useState } from "react";
import type { CapacityWeek, DemandWeek, DeviationWeek } from "@/lib/services";

type Period = {
  label: string;
  periodStart: Date;
  effectiveLoadPct: number; // plant-wide: Σused / ΣeffectiveCapacity across every machine
  demandQty: number;
  onTimePct: number | null;
  productivityPct: number | null;
};

// Real Monthly/Weekly/Daily Planning (Phase 5, agreed with the user) — a
// real multi-week rollup with zero fabrication: Monthly here is a
// client-side re-aggregation of the SAME real weeks the server returned
// (sum real minutes/quantities/counts, then divide once), never an average
// of per-week percentages, which would be subtly wrong whenever weeks
// carry different weight. "Daily" isn't rebuilt a third time — the
// Schedule page's Gantt is already the real day/hour-level view; this page
// links to it instead of duplicating it.
const OVERLOAD_THRESHOLD_PCT = 90;

function weeksToPeriods(capacityWeeks: CapacityWeek[], demandWeeks: DemandWeek[]): Period[] {
  return capacityWeeks.map((cw, i) => {
    const usedTotal = cw.machines.reduce((sum, m) => sum + m.usedMin, 0);
    const capacityTotal = cw.machines.reduce((sum, m) => sum + m.effectiveCapacityMin, 0);
    const effectiveLoadPct = capacityTotal > 0 ? (usedTotal / capacityTotal) * 100 : 0;
    const demandQty = demandWeeks[i]?.totalQuantity ?? 0;
    return {
      label: new Date(cw.weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      periodStart: new Date(cw.weekStart),
      effectiveLoadPct,
      demandQty,
      onTimePct: null,
      productivityPct: null,
    };
  });
}

function mergeDeviation(periods: Period[], deviationWeeks: DeviationWeek[]): Period[] {
  // deviation-rollup is trailing (past weeks); capacity/demand are forward
  // (future weeks) — they only overlap at the current week. Match by
  // weekStart date, real weeks that don't overlap simply show no plan-vs-
  // actual figure yet (honest: there's no real data for a future week's
  // actuals).
  const byDate = new Map(deviationWeeks.map((d) => [new Date(d.weekStart).toDateString(), d]));
  return periods.map((p) => {
    const match = byDate.get(p.periodStart.toDateString());
    return match ? { ...p, onTimePct: match.onTimePct, productivityPct: match.productivityPct } : p;
  });
}

function monthKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}`;
}

// Real re-aggregation into calendar-month buckets — sums the same real
// weekly figures (weighted correctly: totals divided by totals, never an
// average of the weekly percentages) rather than computing anything new.
function toMonthly(periods: Period[], capacityWeeks: CapacityWeek[], demandWeeks: DemandWeek[], deviationWeeks: DeviationWeek[]): Period[] {
  const groups = new Map<string, { start: Date; label: string; idxs: number[] }>();
  periods.forEach((p, i) => {
    const key = monthKey(p.periodStart);
    const g = groups.get(key) ?? { start: p.periodStart, label: p.periodStart.toLocaleDateString(undefined, { month: "long", year: "numeric" }), idxs: [] };
    g.idxs.push(i);
    groups.set(key, g);
  });

  return [...groups.values()]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((g) => {
      let usedTotal = 0;
      let capacityTotal = 0;
      let demandQty = 0;
      let totalOrders = 0;
      let lateOrders = 0;
      let plannedMin = 0;
      let actualMin = 0;
      let hasDeviation = false;
      for (const i of g.idxs) {
        const cw = capacityWeeks[i];
        for (const m of cw.machines) {
          usedTotal += m.usedMin;
          capacityTotal += m.effectiveCapacityMin;
        }
        demandQty += demandWeeks[i]?.totalQuantity ?? 0;
        const dw = deviationWeeks.find((d) => new Date(d.weekStart).toDateString() === periods[i].periodStart.toDateString());
        if (dw) {
          hasDeviation = true;
          totalOrders += dw.totalOrders;
          lateOrders += dw.lateOrders;
          plannedMin += dw.plannedMin;
          actualMin += dw.actualMin;
        }
      }
      return {
        label: g.label,
        periodStart: g.start,
        effectiveLoadPct: capacityTotal > 0 ? (usedTotal / capacityTotal) * 100 : 0,
        demandQty,
        onTimePct: hasDeviation && totalOrders > 0 ? ((totalOrders - lateOrders) / totalOrders) * 100 : null,
        productivityPct: hasDeviation && plannedMin > 0 ? (actualMin / plannedMin) * 100 : null,
      };
    });
}

export function PlanningRollup({
  capacityWeeks,
  demandWeeks,
  deviationWeeks,
}: {
  capacityWeeks: CapacityWeek[];
  demandWeeks: DemandWeek[];
  deviationWeeks: DeviationWeek[];
}) {
  const [view, setView] = useState<"weekly" | "monthly">("weekly");

  const weeklyPeriods = useMemo(() => mergeDeviation(weeksToPeriods(capacityWeeks, demandWeeks), deviationWeeks), [capacityWeeks, demandWeeks, deviationWeeks]);
  const monthlyPeriods = useMemo(() => toMonthly(weeklyPeriods, capacityWeeks, demandWeeks, deviationWeeks), [weeklyPeriods, capacityWeeks, demandWeeks, deviationWeeks]);
  const periods = view === "weekly" ? weeklyPeriods : monthlyPeriods;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button
            type="button"
            onClick={() => setView("weekly")}
            className={`rounded-md px-3 py-1 text-xs font-medium ${view === "weekly" ? "bg-brand-500 text-white" : "text-muted hover:text-foreground"}`}
          >
            Weekly
          </button>
          <button
            type="button"
            onClick={() => setView("monthly")}
            className={`rounded-md px-3 py-1 text-xs font-medium ${view === "monthly" ? "bg-brand-500 text-white" : "text-muted hover:text-foreground"}`}
          >
            Monthly
          </button>
        </div>
        <span className="text-xs text-muted">
          Real data — {view === "weekly" ? `${weeklyPeriods.length} real weeks` : `${monthlyPeriods.length} real months, re-summed from the same weeks`}, capped at the real ~13-week planning horizon.
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
            <tr>
              <th className="px-3 py-2">Period</th>
              <th className="px-3 py-2">Practical Capacity Load</th>
              <th className="px-3 py-2">Demand (qty)</th>
              <th className="px-3 py-2">On-Time %</th>
              <th className="px-3 py-2">Productivity %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {periods.map((p) => {
              const pct = Math.min(Math.max(p.effectiveLoadPct, 0), 150);
              const color = p.effectiveLoadPct > OVERLOAD_THRESHOLD_PCT ? "bg-danger" : p.effectiveLoadPct > 70 ? "bg-warning" : "bg-brand-500";
              return (
                <tr key={p.label}>
                  <td className="px-3 py-2 font-medium text-foreground">{p.label}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-muted">
                        <div className={`h-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <span className="text-xs text-muted">{p.effectiveLoadPct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted">{p.demandQty}</td>
                  <td className="px-3 py-2 text-muted">{p.onTimePct != null ? `${p.onTimePct.toFixed(0)}%` : "—"}</td>
                  <td className="px-3 py-2 text-muted">{p.productivityPct != null ? `${p.productivityPct.toFixed(0)}%` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
